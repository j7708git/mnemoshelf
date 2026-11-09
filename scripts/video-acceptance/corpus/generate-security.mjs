// 生成安全矩陣 fixture（H.264/AAC 與容器變體），並輸出安全矩陣 JSON。
// 產物：security/*.mp4、labels/security-matrix.json、reports/security-fixtures.json
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import {
  COLORS, CORPUS_ROOT, Canvas, FPS, HEIGHT, SAMPLE_RATE, WIDTH, hash32, mixInto, mulberry32,
  probe, relFromCorpus, resolveMediaTools, run, runBuffer, sha256File, startRawVideoEncoder,
  synthEnv, writeJson, writeWavPcm16,
} from "./lib.mjs";

const SEC_DIR = path.join(CORPUS_ROOT, "security");
const WAV_DIR = path.join(CORPUS_ROOT, "wav");
const REPORTS_DIR = path.join(CORPUS_ROOT, "reports");
const LABELS_DIR = path.join(CORPUS_ROOT, "labels");
const BASE = path.join(SEC_DIR, "_base.mp4");

const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------- 通用：raw RGB 串流編碼（可指定尺寸／fps） ----------
async function renderToFile({ out, width = WIDTH, height = HEIGHT, fps = FPS, seconds, audioWav = null, extra = [], withFaststart = true }) {
  const { ffmpeg } = await resolveMediaTools();
  const args = ["-hide_banner", "-loglevel", "error", "-n",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", width + "x" + height, "-r", String(fps), "-i", "pipe:0"];
  if (audioWav) args.push("-i", audioWav, "-map", "0:v:0", "-map", "1:a:0");
  args.push("-c:v", "libopenh264", "-b:v", "900k", "-pix_fmt", "yuv420p", "-g", "48");
  if (audioWav) args.push("-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "1", "-shortest");
  if (withFaststart) args.push("-movflags", "+faststart");
  args.push(...extra, out);
  const enc = await startRawVideoEncoder(args);
  const canvas = new Canvas(width, height);
  const frames = Math.round(seconds * fps);
  for (let f = 0; f < frames; f += 1) {
    canvas.colorBars(f / fps);
    await enc.writeFrame(canvas.buf);
  }
  enc.endInput();
  const done = await enc.done;
  if (done.code !== 0) throw new Error("encode failed for " + out + ": " + done.stderr.slice(0, 3000));
}

async function ffmpeg(args, timeoutMs = 180000) {
  const { ffmpeg: exe } = await resolveMediaTools();
  const result = await run(exe, ["-hide_banner", "-loglevel", "error", "-n", ...args], { timeoutMs });
  if (result.code !== 0) throw new Error("ffmpeg exit " + result.code + ": " + result.stderr.slice(0, 3000));
}

// ---------- ISO-BMFF 小工具（讀 box 佈局、找 moov、偵測 elst、改外部 dref） ----------
function findTopBoxes(buf) {
  const out = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); header = 16; }
    if (size === 0) size = buf.length - pos;
    if (size < header) break;
    out.push({ type, offset: pos, size, header });
    pos += size;
  }
  return out;
}

function findChildBox(buf, type, container) {
  let pos = container.offset + container.header;
  const end = container.offset + container.size;
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    const t = buf.toString("ascii", pos + 4, pos + 8);
    if (size < 8) return null;
    if (t === type) return { type: t, offset: pos, size, header: 8 };
    pos += size;
  }
  return null;
}

function describeLayout(file, buf) {
  const top = findTopBoxes(buf);
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat");
  return {
    topLevelBoxes: top.map((b) => ({ type: b.type, size: b.size })),
    moovOffset: moov?.offset ?? null,
    mdatOffset: mdat?.offset ?? null,
    moovBeforeMdat: moov && mdat ? moov.offset < mdat.offset : null,
    hasElst: buf.includes(Buffer.from("elst")),
    hasDrefExternalUrl: /https?:\/\//.test(buf.toString("latin1")),
  };
}

const CONTAINER_TYPES = new Set(["moov", "trak", "mdia", "minf", "dinf", "edts", "udta"]);

function childBoxes(buf, container) {
  const out = [];
  let pos = container.offset + container.header;
  const end = container.offset + container.size;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); header = 16; }
    if (size === 0) size = end - pos;
    if (size < header) break;
    out.push({ type, offset: pos, size, header });
    pos += size;
  }
  return out;
}

/** 把 moov-at-end 的 MP4 所有 trak 的 dref/url 改成外部 URL；重新序列化 moov（mdat 位移不受影響）。 */
function patchExternalDrefAllTracks(buf, externalUrl) {
  const top = findTopBoxes(buf);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Error("no moov");
  const mdat = top.find((b) => b.type === "mdat");
  if (!mdat || moov.offset < mdat.offset) throw new Error("moov must be after mdat for this patch");
  const urlBytes = Buffer.from(externalUrl + "\0", "latin1");
  const newEntry = Buffer.alloc(8 + 4 + urlBytes.length);
  newEntry.writeUInt32BE(newEntry.length, 0);
  newEntry.write("url ", 4, "ascii");
  newEntry.writeUInt32BE(0x00000000, 8); // version 0、flags 0 = 外部引用
  urlBytes.copy(newEntry, 12);
  let patchedCount = 0;

  const serialize = (box) => {
    const body = buf.subarray(box.offset + box.header, box.offset + box.size);
    if (box.type === "dref") {
      patchedCount += 1;
      // fullbox：version/flags 4 bytes + entry_count 4 bytes + entries；只保留第一個 url entry，換成外部引用。
      const verFlags = body.subarray(0, 4);
      const count = body.readUInt32BE(4);
      const entries = [];
      let pos = 8;
      for (let i = 0; i < count; i += 1) {
        const size = body.readUInt32BE(pos);
        const type = body.toString("ascii", pos + 4, pos + 8);
        entries.push({ size, type, bytes: body.subarray(pos, pos + size) });
        pos += size;
      }
      const first = entries[0];
      if (!first || first.type !== "url ") throw new Error("dref first entry is not url");
      const payload = Buffer.concat([
        verFlags,
        (() => { const b = Buffer.alloc(4); b.writeUInt32BE(count, 0); return b; })(),
        newEntry,
        ...entries.slice(1).map((e) => e.bytes),
      ]);
      const header = Buffer.alloc(8);
      header.writeUInt32BE(payload.length + 8, 0);
      header.write("dref", 4, "ascii");
      return Buffer.concat([header, payload]);
    }
    if (CONTAINER_TYPES.has(box.type)) {
      const parts = childBoxes(buf, box).map(serialize);
      const payload = Buffer.concat(parts);
      const header = Buffer.alloc(8);
      header.writeUInt32BE(payload.length + 8, 0);
      header.write(box.type, 4, "ascii");
      return Buffer.concat([header, payload]);
    }
    return Buffer.from(buf.subarray(box.offset, box.offset + box.size));
  };

  const newMoov = serialize(moov);
  const out = Buffer.concat([buf.subarray(0, moov.offset), newMoov, buf.subarray(moov.offset + moov.size)]);
  return { buffer: out, patchedDrefCount: patchedCount };
}

// ---------- fixture 定義（預期行為＝凍結規格；錯誤碼為提案，B 階段凍結正式名稱） ----------
const FIXTURES = [
  {
    id: "sec01-noaudio", file: "sec01-noaudio.mp4", tags: ["no-audio-track"],
    purpose: "無音軌的 H.264 MP4",
    expected: { stage: "process", outcome: "success", code: null, detail: "視覺索引成功；audio 模態開啟時也不得因『無音軌』失敗或跳過" },
    assertions: ["probe 顯示只有 video stream", "視覺片段數與時長覆蓋相符", "音軌索引為空但不報錯"],
  },
  {
    id: "sec02-ac3", file: "sec02-ac3.mp4", tags: ["unsupported-audio-codec"],
    purpose: "H.264 + AC-3（不支援音軌）",
    expected: { stage: "process", outcome: "skip", code: "unsupported-video-audio-track", detail: "audio 開啟時整檔具名跳過，不做部分成功；只開 video 時可視覺成功（需另測）" },
    assertions: ["不做任何片段寫入", "skip 原因具名且可對帳", "不得只寫視覺片段卻標成整檔成功"],
  },
  {
    id: "sec03-dts", file: "sec03-dts.mp4", tags: ["unsupported-audio-codec"],
    purpose: "H.264 + DTS（不支援音軌；實驗性 dca 編碼器產生）",
    expected: { stage: "process", outcome: "skip", code: "unsupported-video-audio-track", detail: "同 AC-3：audio 開啟時整檔具名跳過" },
    assertions: ["不做任何片段寫入", "skip 原因具名且可對帳"],
  },
  {
    id: "sec04-moov-end", file: "sec04-moov-end.mp4", tags: ["moov-at-end"],
    purpose: "moov 位於 mdat 之後（faststart 關閉）",
    expected: { stage: "process", outcome: "success", code: null, detail: "成功；必須讀到檔尾 moov 才能 probe／抽幀" },
    assertions: ["probe 時長與串流正確", "可抽幀與解音軌", "不需把整個 mdat 讀進記憶體"],
  },
  {
    id: "sec05-vfr", file: "sec05-vfr.mp4", tags: ["vfr"],
    purpose: "可變幀率（非均勻 frame duration）",
    expected: { stage: "process", outcome: "success", code: null, detail: "成功；時間軸用實際 sample timestamps，不得以平均 FPS 虛構片段時間" },
    assertions: ["r_frame_rate != avg_frame_rate", "片段起訖落在來源時間軸", "命中時間可回推原片位置"],
  },
  {
    id: "sec06-rotate90", file: "sec06-rotate90.mp4", tags: ["rotation"],
    purpose: "Display Matrix 旋轉 90 度",
    expected: { stage: "process", outcome: "success", code: null, detail: "成功；解碼後依旋轉呈現（640x360 -> 360x640），縮放前套用" },
    assertions: ["probe 顯示 rotation=90", "輸出幀方向正確且保留比例"],
  },
  {
    id: "sec07-nonzero-pts", file: "sec07-nonzero-pts.mp4", tags: ["nonzero-pts"],
    purpose: "第一個視訊 PTS 為 10 秒（非零起始時間）",
    expected: { stage: "process", outcome: "success", code: null, detail: "成功；時間軸正規化到 0，片段時間仍對應來源內容順序" },
    assertions: ["probe start_time ≈ 10", "首片段起點對應來源 0 秒內容"],
  },
  {
    id: "sec08-editlist", file: "sec08-editlist.mp4", tags: ["edit-list"],
    purpose: "含 edit list（-ss 2 截取後 remux）",
    expected: { stage: "process", outcome: "success", code: null, detail: "成功；依 edit list 有效時間軸，不把編輯前 preroll 當成來源時間" },
    assertions: ["probe 時長 ≈ 10 秒", "片段時間不含被編輯掉的前 2 秒"],
  },
  {
    id: "sec09-external-dref", file: "sec09-external-dref.mp4", tags: ["external-data-reference", "ssrf"],
    purpose: "所有 trak 的 dref/url 都改成外部 URL 的 MP4（container 結構仍可解析）",
    expected: {
      stage: "process",
      outcome: "success",
      code: null,
      detail:
        "實測 FFmpeg n9.0.2 mov demuxer 不解析 dref 外部 URL（debug log「Unknown dref type …」）而用本地 mdat 安全解碼；驗收斷言是『解碼期間零網路請求、零外部檔案讀取』。若日後 wrapper／decoder 會解析外部 dref，必須改為具名拒絕（invalid-video）。",
    },
    assertions: ["沒有 DNS／TCP 連線", "沒有讀取 root 外檔案", "不 crash；錯誤訊息不洩漏環境資訊"],
  },
  {
    id: "sec10-text-as-mp4", file: "sec10-text-as-mp4.mp4", tags: ["fake-extension"],
    purpose: "純文字內容偽裝成 .mp4",
    expected: { stage: "process", outcome: "fail", code: "invalid-video", detail: "具名失敗；不得把文字當媒體、不得 crash" },
    assertions: ["probe 失敗並具名", "檔案不進入索引"],
  },
  {
    id: "sec11-mp4-as-txt", file: "sec11-mp4-as-txt.txt", tags: ["fake-extension"],
    purpose: "有效 MP4 偽裝成 .txt",
    expected: { stage: "scan", outcome: "skip", code: "binary-content", detail: "掃描／內容判定後具名跳過；不得把 MP4 bytes 當文字索引（若改以內容嗅探判定，須具名且不得送文字模型）" },
    assertions: ["不呼叫文字 embedder", "skip 原因具名"],
  },
  {
    id: "sec12-webm-as-mp4", file: "sec12-webm-as-mp4.mp4", tags: ["fake-extension", "unsupported-container"],
    purpose: "WebM（VP9/Opus）內容偽裝成 .mp4",
    expected: { stage: "process", outcome: "fail", code: "unsupported-video-container", detail: "副檔名不得作為支援依據；具名失敗，不得誤標成功" },
    assertions: ["probe／demux 具名拒絕", "錯誤碼可與『壞檔』區分"],
  },
  {
    id: "sec13-zero-bytes", file: "sec13-zero-bytes.mp4", tags: ["zero-byte"],
    purpose: "0 byte 檔案",
    expected: { stage: "process", outcome: "fail", code: "invalid-video", detail: "具名失敗；不得 crash、不得卡住 probe deadline" },
    assertions: ["probe 快速失敗", "失敗原因具名"],
  },
  {
    id: "sec14-truncated-no-moov", file: "sec14-truncated-no-moov.mp4", tags: ["truncated"],
    purpose: "moov-at-end 檔截斷到 40%（moov 完全缺失）",
    expected: { stage: "process", outcome: "fail", code: "invalid-video", detail: "具名失敗；不得把可解碼前段當成整檔成功" },
    assertions: ["probe 失敗並具名", "不寫任何片段"],
  },
  {
    id: "sec15-truncated-mdat", file: "sec15-truncated-mdat.mp4", tags: ["truncated"],
    purpose: "moov 完整但 mdat 截斷（可 probe、解碼到一半失敗）",
    expected: { stage: "process", outcome: "fail", code: "invalid-video", detail: "整檔具名失敗；不得發布部分片段索引（每檔全部片段成功才替換）" },
    assertions: ["初建不留下半檔 chunk／向量", "錯誤可重試且可對帳"],
  },
  {
    id: "sec16-corrupt-moov", file: "sec16-corrupt-moov.mp4", tags: ["corrupt"],
    purpose: "moov 內部位元組損壞",
    expected: { stage: "process", outcome: "fail", code: "invalid-video", detail: "具名失敗；不得 crash 或無限迴圈" },
    assertions: ["probe 失敗並具名", "程序不殘留、不逾時"],
  },
  {
    id: "sec17-oversize-bytes", file: "sec17-oversize-bytes.mp4", tags: ["oversize"],
    purpose: "邏輯大小 513 MiB（> 512 MiB 上限；sparse 檔，不實際佔滿磁碟）",
    expected: { stage: "scan", outcome: "skip", code: "too-large", detail: "掃描階段具名跳過；不得先讀內容或 probe 才判定" },
    assertions: ["scanSkippedFiles 具名", "不開啟檔案內容"],
  },
  {
    id: "sec18-duration-601s", file: "sec18-duration-601s.mp4", tags: ["oversize", "duration-limit"],
    purpose: "時長 601 秒（> 600 秒上限；160x90／4fps 小檔）",
    expected: { stage: "process", outcome: "skip", code: "video-duration-exceeded", detail: "probe 取得時長後具名跳過；不得解碼全部片段" },
    assertions: ["skip 原因具名", "未進行大量解碼（時間／記憶體有界）"],
  },
  {
    id: "sec19-overres-1440p", file: "sec19-overres-1440p.mp4", tags: ["oversize", "resolution-limit"],
    purpose: "2560x1440（> 1920x1080 等價上限）",
    expected: { stage: "process", outcome: "skip", code: "video-resolution-exceeded", detail: "在配置巨大畫面／解碼前具名跳過；不得先解碼再檢查" },
    assertions: ["skip 原因具名", "峰值配置有界"],
  },
  {
    id: "sec20-mixed-audio", file: "sec20-mixed-audio.mp4", tags: ["multi-track", "unsupported-audio-codec"],
    purpose: "兩個音軌：track1 AAC default、track2 AC-3",
    expected: { stage: "process", outcome: "skip", code: "unsupported-video-audio-track", detail: "audio 開啟時整檔具名跳過（v2 決策：含不支援音軌即整檔跳過）；只開 video 時視覺成功" },
    assertions: ["不做部分成功", "若 PM 改採『只選第一個 AAC 音軌』須改契約與本列預期（見備註）"],
  },
];

async function main() {
  if (process.env.VIDEO_SECURITY_GENERATE !== "1") throw new Error("設定 VIDEO_SECURITY_GENERATE=1 才能產生安全素材");
  await fsp.mkdir(path.dirname(CORPUS_ROOT), { recursive: true });
  await fsp.mkdir(CORPUS_ROOT);
  for (const dir of [SEC_DIR, WAV_DIR, REPORTS_DIR, LABELS_DIR]) await fsp.mkdir(dir);
  const tools = await resolveMediaTools();
  const startedAt = new Date().toISOString();

  // 共用素材：12 秒彩條 H.264 + AAC 音軌，以及兩個音軌來源 WAV。
  const baseWav = path.join(WAV_DIR, "sec-audio.wav");
  const secondWav = path.join(WAV_DIR, "sec-audio2.wav");
  {
    const n = 12 * SAMPLE_RATE;
    const buf = new Float32Array(n);
    mixInto(buf, synthEnv("alarm", 12, hash32(11, "sec-audio")), 0, 0.6);
    writeWavPcm16(baseWav, buf);
    const tone = new Float32Array(n);
    mixInto(tone, synthEnv("tone440", 12, hash32(12, "sec-audio2")), 0, 0.5);
    writeWavPcm16(secondWav, tone);
  }
  console.log("encoding base ...");
  await renderToFile({ out: BASE, seconds: 12, audioWav: baseWav });
  const baseBuf = await fsp.readFile(BASE);
  const baseLayout = describeLayout(BASE, baseBuf);
  console.log("base layout:", JSON.stringify(baseLayout));

  const report = { stage: "A2 security matrix fixtures", generatedAt: startedAt, base: { file: "_base.mp4", ...baseLayout }, fixtures: [] };

  const encoders = new Map();
  const addFixture = async (fixture, file, generation, extra = {}) => {
    const p = await probe(file);
    const bytes = (await fsp.stat(file)).size;
    const sha256 = await sha256File(file);
    let buf = null;
    try { buf = await fsp.readFile(file); } catch { /* 超大檔不讀 */ }
    if (buf && buf.length <= 64 * 1024 * 1024) {
      const layout = describeLayout(file, buf);
      extra.layout = layout;
      if (fixture.id === "sec09-external-dref") {
        const text = buf.toString("latin1");
        extra.externalUrlFound = /https?:\/\/[^\0]+/.exec(text)?.[0] ?? null;
      }
    }
    const entry = {
      id: fixture.id,
      file: path.basename(file),
      relPath: relFromCorpus(file),
      tags: fixture.tags,
      purpose: fixture.purpose,
      expected: fixture.expected,
      assertions: fixture.assertions,
      generation,
      sizeBytes: bytes,
      sha256,
      probe: p.ok
        ? {
            ok: true,
            formatDuration: p.json.format.duration,
            formatStartTime: p.json.format.start_time,
            streams: p.json.streams.map((s) => ({
              index: s.index,
              codecType: s.codec_type,
              codecName: s.codec_name,
              width: s.width,
              height: s.height,
              avgFrameRate: s.avg_frame_rate,
              rFrameRate: s.r_frame_rate,
              sampleRate: s.sample_rate,
              channels: s.channels,
              disposition: s.disposition,
              rotation: s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? null,
            })),
          }
        : { ok: false, error: (p.error ?? "").slice(0, 500) },
      ...extra,
    };
    report.fixtures.push(entry);
    encoders.set(fixture.id, entry);
    console.log("  ", fixture.id, bytes, "bytes", p.ok ? "probe ok" : "probe failed");
    return entry;
  };

  // 1) 無音軌：remux 去掉音軌
  await ffmpeg(["-i", BASE, "-t", "12", "-map", "0:v:0", "-c", "copy", "-an", "-movflags", "+faststart", path.join(SEC_DIR, "sec01-noaudio.mp4")]);
  await addFixture(FIXTURES[0], path.join(SEC_DIR, "sec01-noaudio.mp4"), "ffmpeg -i _base.mp4 -t 12 -map 0:v:0 -c copy -an (faststart)");

  // 2) AC-3 音軌
  await ffmpeg(["-i", BASE, "-i", baseWav, "-t", "12", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "ac3", "-b:a", "192k", "-movflags", "+faststart", path.join(SEC_DIR, "sec02-ac3.mp4")]);
  await addFixture(FIXTURES[1], path.join(SEC_DIR, "sec02-ac3.mp4"), "ffmpeg -i _base.mp4 -i sec-audio.wav -map 0:v -map 1:a -c:v copy -c:a ac3 -b:a 192k (faststart)");

  // 3) DTS 音軌（dca 實驗性編碼器）
  await ffmpeg(["-i", BASE, "-i", baseWav, "-t", "12", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "dca", "-strict", "-2", "-b:a", "768k", "-movflags", "+faststart", path.join(SEC_DIR, "sec03-dts.mp4")]);
  await addFixture(FIXTURES[2], path.join(SEC_DIR, "sec03-dts.mp4"), "ffmpeg -i _base.mp4 -i sec-audio.wav -map 0:v -map 1:a -c:v copy -c:a dca -strict -2 -b:a 768k (faststart)");

  // 4) moov 在後
  await ffmpeg(["-i", BASE, "-t", "12", "-c", "copy", path.join(SEC_DIR, "sec04-moov-end.mp4")]);
  await addFixture(FIXTURES[3], path.join(SEC_DIR, "sec04-moov-end.mp4"), "ffmpeg -i _base.mp4 -t 12 -c copy（不帶 faststart）");

  // 5) VFR：select 非均勻抽格保留原 timestamps
  await ffmpeg(["-i", BASE, "-map", "0:v:0", "-map", "0:a:0", "-vf", "select='not(mod(n,5))+not(mod(n,7))'", "-fps_mode", "vfr", "-c:v", "libopenh264", "-b:v", "900k", "-c:a", "copy", "-movflags", "+faststart", path.join(SEC_DIR, "sec05-vfr.mp4")]);
  await addFixture(FIXTURES[4], path.join(SEC_DIR, "sec05-vfr.mp4"), "ffmpeg -i _base.mp4 -vf \"select='not(mod(n,5))+not(mod(n,7))'\" -fps_mode vfr -c:v libopenh264 -c:a copy");

  // 6) 旋轉 90 度（Display Matrix）
  await ffmpeg(["-display_rotation", "90", "-i", BASE, "-t", "12", "-c", "copy", "-movflags", "+faststart", path.join(SEC_DIR, "sec06-rotate90.mp4")]);
  await addFixture(FIXTURES[5], path.join(SEC_DIR, "sec06-rotate90.mp4"), "ffmpeg -display_rotation 90 -i _base.mp4 -t 12 -c copy");

  // 7) 非零起始 PTS
  await ffmpeg(["-i", BASE, "-t", "12", "-c", "copy", "-output_ts_offset", "10", "-movflags", "+faststart", path.join(SEC_DIR, "sec07-nonzero-pts.mp4")]);
  await addFixture(FIXTURES[6], path.join(SEC_DIR, "sec07-nonzero-pts.mp4"), "ffmpeg -i _base.mp4 -t 12 -c copy -output_ts_offset 10");

  // 8) edit list（截取前 2 秒後 remux）
  await ffmpeg(["-ss", "2", "-t", "10", "-i", BASE, "-c", "copy", "-movflags", "+faststart", path.join(SEC_DIR, "sec08-editlist.mp4")]);
  await addFixture(FIXTURES[7], path.join(SEC_DIR, "sec08-editlist.mp4"), "ffmpeg -ss 2 -t 10 -i _base.mp4 -c copy");

  // 9) 外部 data reference：對 moov-at-end 檔 patch dref
  {
    const extUrl = "https://example.invalid/a2-external-ref.mdat";
    const patched = patchExternalDrefAllTracks(await fsp.readFile(path.join(SEC_DIR, "sec04-moov-end.mp4")), extUrl);
    const outFile = path.join(SEC_DIR, "sec09-external-dref.mp4");
    await fsp.writeFile(outFile, patched.buffer);
    await addFixture(FIXTURES[8], outFile, "重新序列化 moov，把所有 trak 的 dref/url 換成外部 URL（scripts/generate-security.mjs）", {
      externalUrl: extUrl,
      patchedDrefCount: patched.patchedDrefCount,
    });
  }

  // 10) 文字偽裝 .mp4
  await fsp.writeFile(path.join(SEC_DIR, "sec10-text-as-mp4.mp4"), Buffer.from("this is not a video file, just plain text pretending to be mp4\n".repeat(20), "utf8"));
  await addFixture(FIXTURES[9], path.join(SEC_DIR, "sec10-text-as-mp4.mp4"), "純文字 bytes 寫入 .mp4");

  // 11) 有效 MP4 偽裝 .txt
  await fsp.writeFile(path.join(SEC_DIR, "sec11-mp4-as-txt.txt"), await fsp.readFile(path.join(SEC_DIR, "sec04-moov-end.mp4")));
  await addFixture(FIXTURES[10], path.join(SEC_DIR, "sec11-mp4-as-txt.txt"), "複製 sec04-moov-end.mp4 為 .txt");

  // 12) WebM 偽裝 .mp4
  await ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=3", "-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "libopus", "-f", "webm", path.join(SEC_DIR, "_tmp.webm")]);
  await fsp.copyFile(path.join(SEC_DIR, "_tmp.webm"), path.join(SEC_DIR, "sec12-webm-as-mp4.mp4"));
  // 中間產物留在本次 run，供查核。
  await addFixture(FIXTURES[11], path.join(SEC_DIR, "sec12-webm-as-mp4.mp4"), "ffmpeg 產生 VP9/Opus WebM 後改名 .mp4");

  // 13) 0 byte
  await fsp.writeFile(path.join(SEC_DIR, "sec13-zero-bytes.mp4"), Buffer.alloc(0));
  await addFixture(FIXTURES[12], path.join(SEC_DIR, "sec13-zero-bytes.mp4"), "空檔案");

  // 14) 截斷到 40%（moov-at-end 檔 → moov 完全缺失）
  {
    const src = await fsp.readFile(path.join(SEC_DIR, "sec04-moov-end.mp4"));
    await fsp.writeFile(path.join(SEC_DIR, "sec14-truncated-no-moov.mp4"), src.subarray(0, Math.floor(src.length * 0.4)));
    await addFixture(FIXTURES[13], path.join(SEC_DIR, "sec14-truncated-no-moov.mp4"), "sec04-moov-end.mp4 取前 40% bytes");
  }

  // 15) moov 完整、mdat 截斷（base 是 faststart，取前 60%）
  {
    const src = await fsp.readFile(BASE);
    await fsp.writeFile(path.join(SEC_DIR, "sec15-truncated-mdat.mp4"), src.subarray(0, Math.floor(src.length * 0.6)));
    await addFixture(FIXTURES[14], path.join(SEC_DIR, "sec15-truncated-mdat.mp4"), "_base.mp4（moov 在前）取前 60% bytes");
  }

  // 16) moov 位元組損壞
  {
    const src = Buffer.from(await fsp.readFile(BASE));
    const top = findTopBoxes(src);
    const moov = top.find((b) => b.type === "moov");
    if (!moov) throw new Error("base has no moov");
    src.fill(0, moov.offset, moov.offset + 8); // 破壞 moov box header（size/type）
    await fsp.writeFile(path.join(SEC_DIR, "sec16-corrupt-moov.mp4"), src);
    await addFixture(FIXTURES[15], path.join(SEC_DIR, "sec16-corrupt-moov.mp4"), "把 _base.mp4 的 moov box header（8 bytes）歸零，其餘 bytes 保留");
  }

  // 17) 超尺寸（sparse 513 MiB）
  {
    const target = path.join(SEC_DIR, "sec17-oversize-bytes.mp4");
    const handle = await fsp.open(target, "w");
    await handle.truncate(513 * 1024 * 1024 + 1);
    await handle.close();
    const st = await fsp.stat(target);
    await addFixture(FIXTURES[16], target, "fs.truncate 成 513 MiB + 1 byte 的 sparse 檔（不寫入內容）", { logicalBytes: st.size });
  }

  // 18) 時長 601 秒（160x90、4 fps、無音軌）
  await renderToFile({ out: path.join(SEC_DIR, "sec18-duration-601s.mp4"), width: 160, height: 90, fps: 4, seconds: 601, audioWav: null });
  await addFixture(FIXTURES[17], path.join(SEC_DIR, "sec18-duration-601s.mp4"), "libopenh264 160x90@4fps 601 秒彩條（無音軌）");

  // 19) 解析度 2560x1440（1 秒、8 fps）
  await renderToFile({ out: path.join(SEC_DIR, "sec19-overres-1440p.mp4"), width: 2560, height: 1440, fps: 8, seconds: 1, audioWav: null });
  await addFixture(FIXTURES[18], path.join(SEC_DIR, "sec19-overres-1440p.mp4"), "libopenh264 2560x1440@8fps 1 秒彩條（無音軌）");

  // 20) 混用音軌：AAC(default) + AC-3
  await ffmpeg(["-i", BASE, "-i", baseWav, "-i", secondWav, "-t", "12", "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
    "-c:v", "copy", "-c:a:0", "aac", "-b:a:0", "128k", "-c:a:1", "ac3", "-b:a:1", "192k",
    "-disposition:a:0", "default", "-disposition:a:1", "0", "-movflags", "+faststart", path.join(SEC_DIR, "sec20-mixed-audio.mp4")]);
  await addFixture(FIXTURES[19], path.join(SEC_DIR, "sec20-mixed-audio.mp4"), "ffmpeg -i _base -i sec-audio -i sec-audio2 -map 0:v -map 1:a -map 2:a -c:a:0 aac -c:a:1 ac3");

  // 觀測：每個 fixture 的實際解碼行為（供矩陣對照；不是產品驗收）
  const versionOut = await run(tools.ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 30000 });
  report.ffmpeg = {
    versionFirstLine: versionOut.stdout.split(/\r?\n/).find((l) => l.startsWith("ffmpeg version")) ?? null,
    sha256: await sha256File(tools.ffmpeg),
    ffprobeSha256: await sha256File(tools.ffprobe),
  };

  const decodeFirstFrame = async (file) => {
    try {
      const r = await run(tools.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-f", "null", "-"], { timeoutMs: 30000 });
      return { code: r.code, stderrTail: r.stderr.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 400) };
    } catch (error) {
      return { code: null, error: String(error).slice(0, 400) };
    }
  };
  const fullDecode = async (file, timeoutMs = 120000) => {
    try {
      const r = await run(tools.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "null", "-"], { timeoutMs });
      return { code: r.code, stderrTail: r.stderr.trim().split(/\r?\n/).slice(-4).join(" | ").slice(0, 600) };
    } catch (error) {
      return { code: null, error: String(error).slice(0, 400) };
    }
  };

  const observed = {};
  for (const fixture of FIXTURES) {
    const file = path.join(SEC_DIR, fixture.file);
    const obs = {};
    if (["sec17-oversize-bytes", "sec18-duration-601s"].includes(fixture.id)) {
      obs.note = "依預期在掃描／probe 階段即跳過，不做解碼（避免無意義的大量 I/O）";
    } else {
      obs.firstFrame = await decodeFirstFrame(file);
    }
    if (fixture.id === "sec05-vfr") {
      const out = await runBuffer(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#10", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file], { timeoutMs: 60000 });
      obs.ptsSample = out.toString().trim().split(/\r?\n/).map(Number);
    }
    if (fixture.id === "sec09-external-dref") {
      obs.fullDecode = await fullDecode(file);
      const debug = await run(tools.ffmpeg, ["-hide_banner", "-v", "debug", "-i", file, "-frames:v", "1", "-f", "null", "-"], { timeoutMs: 60000, cwd: SEC_DIR });
      const lines = debug.stderr.split(/\r?\n/).filter((l) => /dref|external|example\.invalid|Opening 'http/i.test(l));
      obs.drefLogs = lines.slice(0, 10);
      obs.networkRefsInLog = lines.filter((l) => /Opening 'http|https:/i.test(l)).length;
    }
    if (fixture.id === "sec15-truncated-mdat") {
      obs.fullDecode = await fullDecode(file);
      const progress = await run(tools.ffmpeg, ["-hide_banner", "-v", "error", "-progress", "pipe:1", "-i", file, "-f", "null", "-"], { timeoutMs: 60000 });
      const frames = [...progress.stdout.matchAll(/^frame=(\d+)$/gm)].map((m) => Number(m[1]));
      obs.decodedFrames = frames.length ? frames[frames.length - 1] : null;
      obs.expectedFrames = 288;
      obs.note = "實測：ffmpeg 退出碼仍為 0，但 stderr 有 partial file／Invalid NAL，只解出部分幀。decoder wrapper 不能只看 exit code，必須比對解出幀數／時長並具名失敗。";
    }
    if (fixture.id === "sec12-webm-as-mp4") {
      const fpOut = await run(tools.ffprobe, ["-v", "error", "-show_entries", "format=format_name,duration", "-of", "json", file], { timeoutMs: 30000 });
      try { obs.ffprobeFormat = JSON.parse(fpOut.stdout).format; } catch { obs.ffprobeFormat = { raw: fpOut.stdout.slice(0, 300) }; }
    }
    if (fixture.id === "sec16-corrupt-moov" || fixture.id === "sec19-overres-1440p") {
      obs.note = "解碼第一幀觀測記錄；不代表產品驗收";
    }
    observed[fixture.id] = obs;
    const target = report.fixtures.find((f) => f.id === fixture.id);
    if (target) target.observed = obs;
    console.log("  observed", fixture.id, JSON.stringify(obs).slice(0, 220));
  }

  // 保留本次 run 的實驗資料，不清理既有結果。

  const matrix = {
    schemaVersion: 1,
    corpusId: "mnemoshelf-video-a2-security-matrix-v1",
    generatedAt: startedAt,
    generator: "scripts/generate-security.mjs",
    tool: {
      ffmpegVersion: "n9.0.2-48-gd4070a14ce（BtbN win64 LGPLv3 static build；無 libx264）",
      encoder: "libopenh264（H.264 Constrained Baseline）+ aac",
    },
    expectationVocabulary: {
      outcome: {
        success: "整檔成功（依模態組合做應做的索引）",
        skip: "具名跳過（scanSkippedFiles 或 skippedFiles，不寫片段）",
        fail: "具名失敗（failedFiles／可重試錯誤；不寫片段、不 crash）",
      },
      stage: {
        scan: "掃描階段即可判定（不讀內容）",
        process: "處理階段（probe／decode 後）判定",
      },
      codeNote: "錯誤碼為 A2 提案；B 階段契約必須凍結正式名稱並加契約測試。code=null 表示成功不帶錯誤。",
    },
    fixtures: report.fixtures.map((f) => ({
      id: f.id,
      file: f.file,
      tags: f.tags,
      purpose: f.purpose,
      expected: f.expected,
      assertions: f.assertions,
      actualProbe: f.probe,
      layout: f.layout ?? null,
      observed: f.observed ?? null,
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
    })),
  };
  await writeJson(path.join(REPORTS_DIR, "security-fixtures.json"), report);
  await writeJson(path.join(LABELS_DIR, "security-matrix.json"), matrix);
  console.log("done.", report.fixtures.length, "fixtures");
}

main().catch((error) => {
  console.error("FAILED:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
