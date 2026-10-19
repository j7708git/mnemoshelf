/**
 * 索引限速（`MNEMOSHELF_INDEX_RATE`）與 `/roots/:id/index` 接線的測試。
 *
 * 為什麼要測到 HTTP：限速的設定由 `config.ts` 解析、`createServer` 接線、REST app 傳進
 * `indexRoot`——任何一層漏接都不會有錯誤，只會「設了沒生效」。
 *
 * **決定性**（修復 F2-1；原版用 `low >= off + 300ms` 的總時間差，在全量並行 `pnpm test`
 * 會因排程負載 flake）：
 * - 注入一個記錄每批嵌入起始時間的零延遲 fake embedder，並宣告 `serializedInference: true`
 *   讓索引器固定「檔案間併發 1」——檔案與檔案之間的順序與次數因此是固定的。
 * - `low` 直接驗證「每個檔與檔之間真的睡了 ≥ 240ms」（下限；負載只會讓 gap 變大，不會變小）。
 * - `off` 驗證**傳給索引器的限速參數是 undefined**（同一條接線的另一端），不做上界計時比較
 *   （上界才是不穩定的來源）。這比原本的總時間差斷言更直接，沒有放寬產品行為。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import type {
  DocumentInput,
  EmbedDocumentsOptions,
  EmbedderRuntimeStatus,
} from "@mnemoshelf/core";
import {
  createServer,
  loadServerConfig,
  ValidationError,
  type IndexRootResponse,
  type MnemoshelfServer,
} from "../src/index.js";
import { api, makeTempDir, removeTempDir, TEST_TOKEN } from "./helpers.js";

/** 每個檔案的內容（一份檔案＝一個 chunk，批次呼叫次數因此等於檔案數）。 */
const FILE_COUNT = 4;

/** 建立一個含 `count` 個小檔案的合成 root。 */
async function makeRateRoot(count: number): Promise<string> {
  const dir = await makeTempDir("mnemoshelf-rate-root-");
  for (let index = 0; index < count; index += 1) {
    await fs.writeFile(
      path.join(dir, `note-${index}.md`),
      `# 檔案 ${index}\n\n這是索引限速測試用的合成內容（第 ${index} 份）。\n`,
      "utf8",
    );
  }
  return dir;
}

/**
 * 記錄 `embedDocuments` 起始時間的零延遲 embedder。
 *
 * `serializedInference: true` 讓 `indexRoot` 把檔案間併發固定為 1（與 DirectML 的既有語意
 * 相同），因此「第 n 個批次 → 第 n+1 個批次」之間只會是限速休眠＋毫秒級寫入。
 */
class RecordingEmbedder extends FakeEmbedder {
  readonly batchStarts: number[] = [];

  readonly runtimeStatus: EmbedderRuntimeStatus = {
    requestedDevice: "cpu",
    device: "cpu",
    loaded: true,
    fallbackReason: null,
    batchSize: 16,
    serializedInference: true,
    dmlDeviceId: null,
  };

  override async embedDocuments(
    inputs: readonly DocumentInput[],
    opts?: EmbedDocumentsOptions,
  ): Promise<Float32Array[]> {
    this.batchStarts.push(performance.now());
    return await super.embedDocuments(inputs, opts);
  }
}

interface RateRun {
  durationMs: number;
  processed: number;
  failed: number;
  batches: number;
  gaps: number[];
  indexThrottle: MnemoshelfServer["app"]["indexThrottle"];
}

/** 起一個 server、索引 4 檔的 root，回傳結果與每批嵌入的間隔。 */
async function measureIndex(rate: "off" | "low"): Promise<RateRun> {
  const rootDir = await makeRateRoot(FILE_COUNT);
  const dataDir = await makeTempDir("mnemoshelf-rate-data-");
  const embedder = new RecordingEmbedder();
  let server: MnemoshelfServer | undefined;
  try {
    server = await createServer({
      env: { MNEMOSHELF_INDEX_RATE: rate },
      token: TEST_TOKEN,
      dataDir,
      port: 0,
      embedder,
      homeDir: os.homedir(),
    });
    expect(server.config.indexRate).toBe(rate);

    const created = await api(server, "POST", "/roots", {
      body: { path: rootDir, modalities: ["text"] },
    });
    expect(created.status).toBe(201);
    const root = created.body as { id: number };
    const indexed = await api(server, "POST", `/roots/${root.id}/index`);
    expect(indexed.status).toBe(200);
    const body = indexed.body as IndexRootResponse;

    const gaps: number[] = [];
    for (let index = 1; index < embedder.batchStarts.length; index += 1) {
      gaps.push(embedder.batchStarts[index]! - embedder.batchStarts[index - 1]!);
    }
    return {
      durationMs: body.durationMs,
      processed: body.processed,
      failed: body.failedFiles.length,
      batches: embedder.batchStarts.length,
      gaps,
      indexThrottle: server.app.indexThrottle,
    };
  } finally {
    await server?.close();
    await removeTempDir(rootDir);
    await removeTempDir(dataDir);
  }
}

describe("MNEMOSHELF_INDEX_RATE 設定", () => {
  it("預設 off；接受 off／normal／low（大小寫不拘），其他值以 ValidationError 拒絕", () => {
    expect(loadServerConfig({ MNEMOSHELF_TOKEN: "test" }).indexRate).toBe("off");
    expect(loadServerConfig({ MNEMOSHELF_TOKEN: "test", MNEMOSHELF_INDEX_RATE: "NORMAL" }).indexRate).toBe("normal");
    expect(loadServerConfig({ MNEMOSHELF_TOKEN: "test", MNEMOSHELF_INDEX_RATE: " low " }).indexRate).toBe("low");

    for (const value of ["bogus", "1", "fast"]) {
      expect(() => loadServerConfig({ MNEMOSHELF_TOKEN: "test", MNEMOSHELF_INDEX_RATE: value })).toThrow(
        ValidationError,
      );
    }
    // 空字串視為未設定（與其他可選環境變數一致）。
    expect(loadServerConfig({ MNEMOSHELF_TOKEN: "test", MNEMOSHELF_INDEX_RATE: "  " }).indexRate).toBe("off");
  });

  it("非法值讓 createServer 啟動失敗（不建立資料目錄）", async () => {
    const dataDir = path.join(os.tmpdir(), `mnemoshelf-rate-invalid-${process.pid}-${Date.now()}`);
    await expect(
      createServer({
        env: { MNEMOSHELF_INDEX_RATE: "turbo" },
        token: TEST_TOKEN,
        dataDir,
        port: 0,
        embedder: new FakeEmbedder(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(fs.stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("索引限速接線（HTTP）", () => {
  it("low：每兩個檔案之間真的休眠 ≥240ms，且結果完整", async () => {
    const low = await measureIndex("low");

    // 接線：設定值確實變成傳給 indexRoot 的參數。
    expect(low.indexThrottle).toEqual({ betweenFilesMs: 250 });
    // 4 個檔案、檔案間併發 1 → 恰好 4 次批次呼叫、3 個 between-file 間隔。
    expect(low.batches).toBe(FILE_COUNT);
    expect(low.gaps).toHaveLength(FILE_COUNT - 1);
    for (const gap of low.gaps) {
      // 只驗下限：250ms 的休眠不可能更短；機器負載只會讓 gap 更長。
      expect(gap).toBeGreaterThanOrEqual(240);
    }
    // 限速只影響節奏：結果仍完整（沒有失敗檔）。
    expect(low.processed).toBe(FILE_COUNT);
    expect(low.failed).toBe(0);
    expect(low.durationMs).toBeGreaterThanOrEqual(240 * (FILE_COUNT - 1));
  });

  it("off：不傳限速參數（行為與未限速相同），且結果完整", async () => {
    const off = await measureIndex("off");

    // 接線的另一端：off 完全不出現 throttle 參數（不是傳 0）。
    expect(off.indexThrottle).toBeUndefined();
    expect(off.batches).toBe(FILE_COUNT);
    expect(off.processed).toBe(FILE_COUNT);
    expect(off.failed).toBe(0);
  });
});
