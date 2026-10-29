#!/usr/bin/env node
/**
 * 桌面殼的驗收驅動：在 xvfb 下啟動 `--dir` 打包產物，跑完桌面殼的每一個行為並留下證據。
 *
 * 用法（於 repo 根目錄或 `packages/desktop/` 皆可）：
 *   node packages/desktop/scripts/smoke.mjs [all|gui|interrupt|headless|hidden] [選項]
 *
 * 子命令：
 * - `gui`（預設）：一次啟動跑
 *   `bootstrap,app,agent-guide,single,browser,index,autostart,agent,tray` 九個情境——
 *   模型下載進度→就緒、桌面模式不貼 token、連接 Agent 頁四個 tab 的偵測結果與截圖、
 *   真剪貼簿複製且不含 token、單一實例鎖、瀏覽器模式仍走手動貼 token、
 *   加入資料夾／索引／搜尋、開機自啟開關、Agent 連線資訊、關窗縮到系統匣與系統匣離開。
 * - `agent-guide`（在上述預設清單內）：四個 tab 逐一截圖、複製安裝卡與片段到真剪貼簿，
 *   斷言含必要字串且不含 token；剪貼簿內容不進報告。順序上必須排在 `agent` 之前：
 *   `agent` 情境會關閉 Agent 連線資訊並刪掉 `runtime.json`（且要重啟才重寫），
 *   排後面會讓複製與 token 斷言失去前提。
 * - `interrupt`：模擬「下載中斷」——第一次跑到有進度就 SIGKILL，第二次重啟確認沿用已下載的檔案並完成。
 * - `headless`：以 `--headless` 啟動，確認沒有視窗、服務可以用 curl 帶 token 打到。
 * - `hidden`（M2 的回歸驗收）：以 `--hidden` 啟動（開機自啟那條路徑）跑 `hidden` 情境，確認視窗
 *   建好、UI 載入、第一次 `ready-to-show` 之後仍不可見；接著**不帶** `--hidden` 跑同一個情境，
 *   確認它會明確失敗（前提不成立時不能靜靜通過）。
 * - `all`：依序跑 `gui`、`interrupt`、`headless`、`hidden`。
 *
 * 選項：`--out <dir>`、`--user-data <dir>`、`--sample-root <dir>`、`--skip-build`、`--only <情境>`。
 *
 * 需要 `xvfb-run`（headless 的 GUI session；Electron 沒有 display 起不來）。第一次跑會下載模型（約 300 MB）。
 * CI／`chrome-sandbox` 不是 setuid 的環境（例如 GitHub runner）GUI 啟動會被 Chromium sandbox 擋下；
 * 設環境變數 `MNEMOSHELF_SMOKE_NO_SANDBOX=1` 會在使用者 args 前加上 `--no-sandbox`。
 * 這個開關**只給上述環境用**，預設關閉；本機手動跑請維持原行為。
 * **`XDG_CONFIG_HOME` 一律指到 `.tmp/` 底下**，因此開機自啟的驗收不會動到使用者真正的 `~/.config/autostart`。
 *
 * 產物：`<out>/report/`（截圖與 report.json）、`<out>/*.log`、`<out>/summary.json`（未進版控）。
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");
const repoRoot = path.resolve(packageDir, "..", "..");

/** Electron 產物裡的其他執行檔（不是應用程式本體），列出來避免誤選。 */
const NON_APP_EXECUTABLES = new Set(["chrome-sandbox", "chrome_crashpad_handler"]);

/** electron-builder 的 `--dir` 產物目錄後綴。 */
const UNPACKED_DIR_SUFFIX = "-unpacked";

/** 目錄名裡可能出現的架構標記（用來判斷某個候選是不是別的架構的產物）。 */
const ARCH_TOKENS = ["x86_64", "x64", "arm64", "armv7l", "ia32"];

function parseArgs(argv) {
  const args = { command: "all", out: null, userData: null, sampleRoot: null, skipBuild: false, only: null };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--out") args.out = value;
    else if (key === "--user-data") args.userData = value;
    else if (key === "--sample-root") args.sampleRoot = value;
    else if (key === "--only") args.only = value;
    else if (key === "--skip-build") args.skipBuild = true;
    else if (!key.startsWith("--")) positionals.push(key);
  }
  if (positionals.length > 0) args.command = positionals[0];
  if (!["all", "gui", "interrupt", "headless", "hidden"].includes(args.command)) {
    throw new Error(`不認得的子命令：${args.command}（可用：all／gui／interrupt／headless／hidden）`);
  }
  return args;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 挑出 `dist-app/` 底下的未封裝產物目錄。
 *
 * **不要寫死目錄名**：electron-builder 的 `--dir` 輸出目錄會隨架構變動——x64 是
 * `linux-unpacked`，非 x64 會多一段架構後綴（arm64 runner 上是 `linux-arm64-unpacked`）。
 * 寫死 `linux-unpacked` 會讓 arm64 的 CI leg 找不到產物而必紅。
 *
 * 同時存在多個候選時（例如同一個輸出目錄建過兩種架構）：優先取目錄名含 `arch` 的，
 * 其次是「沒有標明架構」的那個（＝建置機器預設架構），最後才退回第一個。
 */
async function findUnpackedDir(distApp, arch = process.arch) {
  const entries = await fs.readdir(distApp, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(UNPACKED_DIR_SUFFIX))
    .map((entry) => path.join(distApp, entry.name))
    .sort((a, b) => a.localeCompare(b));
  if (candidates.length === 0) {
    throw new Error(
      `在 ${distApp} 找不到未封裝產物目錄（*-unpacked），請先跑 \`pnpm --filter @mnemoshelf/desktop dist\``,
    );
  }
  const matchesArch = (dir) => {
    const name = path.basename(dir);
    const tokens = ARCH_TOKENS.filter((token) => name.includes(token));
    return tokens.length === 0 || tokens.includes(arch);
  };
  return candidates.find((dir) => path.basename(dir).includes(arch)) ?? candidates.find(matchesArch) ?? candidates[0];
}

/** 找到未封裝產物目錄裡的應用程式執行檔（頂層那個）。 */
async function findExecutable(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (NON_APP_EXECUTABLES.has(entry.name)) continue;
    if (entry.name.includes(".")) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.stat(full);
    if ((stat.mode & 0o111) !== 0) candidates.push(full);
  }
  if (candidates.length === 0) {
    throw new Error(`在 ${dir} 找不到執行檔，請先跑 \`pnpm --filter @mnemoshelf/desktop dist\``);
  }
  return candidates[0];
}

/** 產生一張簡單的 PNG（樣本圖片用；不引入任何相依套件）。 */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 準備測試資料夾（合成資料；第一次跑時建立）。 */
async function ensureSampleRoot(dir) {
  await fs.mkdir(dir, { recursive: true });
  const text = [
    "Mnemoshelf 桌面殼的驗收樣本檔。",
    "",
    "桌面殼：系統匣、關窗縮到匣、單一實例鎖、開機自啟、headless 模式。",
    "token 由應用程式自己管：safeStorage 加密保存，呼叫 API 時由 main process 注入標頭。",
    "首次啟動會先下載模型並顯示進度；中斷後重試只會抓缺少的部分。",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "hello.txt"), text, "utf8");
  const png = encodePng(400, 260, (x, y) => (x < 200 ? [37, 51, 82, 255] : [(x + y) % 256, 200, 120, 255]));
  await fs.writeFile(path.join(dir, "picture.png"), png);
  return dir;
}

/** 遞迴列出目錄（含大小），用來記錄模型目錄的狀態。 */
async function listFiles(dir) {
  const files = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const stat = await fs.stat(full).catch(() => null);
        files.push({ relPath: path.relative(dir, full), bytes: stat?.size ?? 0 });
      }
    }
  };
  await walk(dir);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

async function dirSize(dir) {
  const files = await listFiles(dir);
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

async function dirExists(dir) {
  return fs
    .stat(dir)
    .then(() => true)
    .catch(() => false);
}

/**
 * 送訊號給整個行程群組。
 *
 * 為什麼要這樣：應用程式是包在 `xvfb-run`（shell script）底下啟動的，只對 xvfb-run 送訊號
 * 不會轉到 Electron（headless 驗收就會卡住等不到結束）。用 `detached: true` 讓子行程自成
 * 一個行程群組，之後對 `-pid` 送訊號就能一次收乾淨。
 */
function signalProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 已經結束了。
    }
  }
}

/**
 * 找出 Electron 的 browser process（＝應用程式本體，不是 `--type=` 的子行程）。
 *
 * 為什麼需要：應用程式包在 `xvfb-run` 底下，對整個行程群組送 SIGTERM 會先殺掉 xvfb-run，
 * 就看不到應用程式自己的收尾 log 與退出碼。直接對 browser process 送訊號才能驗「優雅結束」。
 */
async function findBrowserProcess(executable) {
  const entries = await fs.readdir("/proc").catch(() => []);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const raw = await fs.readFile(`/proc/${entry}/cmdline`).catch(() => null);
    if (raw === null) continue;
    const cmdline = raw.toString("utf8").split("\0").filter((part) => part !== "");
    if (cmdline.length === 0) continue;
    // 注意：Electron 會把 argv[0] 改寫成完整的命令列字串（Chromium 的行程標題），
    // 所以第一個元素不一定是乾淨的執行檔路徑，要用「整串開頭」比對。
    const title = cmdline.join(" ");
    if (!title.startsWith(executable)) continue;
    if (title.includes("--type=")) continue;
    return Number(entry);
  }
  return null;
}

/**
 * 清掉上一次沒收乾淨的行程（同一 userData 會佔住單一實例鎖）：先清掉再跑，避免誤判成失敗。
 */
async function cleanupInstances(executable) {
  await new Promise((resolve) => {
    const cleanup = spawn("pkill", ["-f", executable], { stdio: "ignore" });
    cleanup.on("close", () => resolve());
    cleanup.on("error", () => resolve());
  });
  await delay(500);
}

/**
 * 跑一次「以 `--hidden` 啟動（或不帶）＋ `hidden` 情境」並回收結果。
 *
 * 情境本身不需模型，沿用 gui 的 userData（模型快取若已在磁碟上就不會重新下載）；
 * 若該 userData 還沒有模型，背景的下載會在驗收結束時中斷——留下的暫存檔由下一次啟動清掉。
 */
async function runHiddenCheck({ executable, baseEnv, userData, outRoot, withHidden }) {
  const label = withHidden ? "hidden" : "hidden-control";
  const out = path.join(outRoot, `report-${label}`);
  await fs.rm(out, { recursive: true, force: true });
  await cleanupInstances(executable);
  const result = await runApp({
    executable,
    args: withHidden ? ["--hidden"] : [],
    logFile: path.join(outRoot, `${label}.log`),
    env: {
      ...baseEnv,
      MNEMOSHELF_DESKTOP_USER_DATA: userData,
      MNEMOSHELF_AUTOTEST: "hidden",
      MNEMOSHELF_AUTOTEST_OUT: out,
    },
  });
  const report = await fs
    .readFile(path.join(out, "report.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  return {
    exitCode: result.code,
    signal: result.signal,
    modeLine: result.lines.find((line) => line.includes("模式：")) ?? null,
    reportOk: report?.ok ?? null,
    failure: report?.failure ?? null,
    steps: report?.steps?.map((step) => `${step.ok ? "✓" : "✗"} [${step.scenario}] ${step.name}：${step.detail}`) ?? [],
  };
}

/**
 * 跑一次打包產物。
 *
 * @returns {{ code: number|null, signal: string|null, log: string, lines: string[] }}
 */
async function runApp({ executable, env, args = [], logFile, onLine, killWhen = null }) {
  const stream = createWriteStream(logFile, { flags: "w" });
  const lines = [];
  // CI／chrome-sandbox 不是 setuid 的環境需要 `--no-sandbox` 才能啟動 GUI（headless smoke 不受影響）。
  // 預設不開；`--no-sandbox` 必須放在 executable 之後、使用者 args 之前。
  const sandboxArgs = env?.MNEMOSHELF_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1440x1000x24", executable, ...sandboxArgs, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const consume = (chunk) => {
    stream.write(chunk);
    for (const line of String(chunk).split("\n")) {
      if (line.trim() === "") continue;
      process.stdout.write(`${line}\n`);
      lines.push(line);
      onLine?.(line);
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  let killed = null;
  if (killWhen !== null) {
    const watch = (async () => {
      for (;;) {
        if (child.exitCode !== null) return;
        if (await killWhen(lines)) {
          killed = "SIGKILL";
          signalProcessGroup(child, "SIGKILL");
          return;
        }
        await delay(250);
      }
    })();
    watch.catch(() => undefined);
  }

  const result = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  stream.end();
  return { ...result, log: logFile, lines, killed };
}

/** 等某一行出現（或超時）。 */
async function waitForLine(lines, predicate, timeoutMs, description) {
  const startedAt = Date.now();
  for (;;) {
    const found = lines.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等待逾時（${description}）`);
    await delay(250);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outRoot = path.resolve(args.out ?? path.join(repoRoot, ".tmp", "desktop-shell"));
  await fs.mkdir(outRoot, { recursive: true });

  const distApp = path.join(packageDir, "dist-app");
  if (!args.skipBuild && !existsSync(distApp)) {
    console.log("[smoke] 找不到打包產物：先跑 `pnpm --filter @mnemoshelf/desktop dist`");
  }
  const unpacked = await findUnpackedDir(distApp);
  console.log(`[smoke] 未封裝產物目錄：${path.relative(repoRoot, unpacked)}`);
  const executable = await findExecutable(unpacked);
  // 上一次沒收乾淨的行程會佔住單一實例鎖（同一 userData）：先清掉再跑，避免誤判成失敗。
  await cleanupInstances(executable);

  const sampleRoot = await ensureSampleRoot(
    path.resolve(args.sampleRoot ?? path.join(repoRoot, ".tmp", "desktop-spike", "sample-root")),
  );
  // 一律用暫存目錄當 XDG_CONFIG_HOME：開機自啟的驗收不會碰到使用者真正的 ~/.config。
  const xdgConfigHome = path.join(outRoot, "xdg-config");
  const autostartDir = path.join(xdgConfigHome, "autostart");
  const autostartFile = path.join(autostartDir, "mnemoshelf.desktop");
  await fs.rm(xdgConfigHome, { recursive: true, force: true });
  await fs.mkdir(autostartDir, { recursive: true });

  const baseEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdgConfigHome,
    MNEMOSHELF_AUTOTEST_SAMPLE_ROOT: sampleRoot,
    MNEMOSHELF_AUTOTEST_QUERY: "桌面殼 系統匣",
  };

  const summary = { command: args.command, executable, sampleRoot, xdgConfigHome, results: {}, ok: true };
  const commands = args.command === "all" ? ["gui", "interrupt", "headless", "hidden"] : [args.command];

  for (const command of commands) {
    if (command === "gui") {
      const userData = path.resolve(args.userData ?? path.join(outRoot, "userData-gui"));
      const out = path.join(outRoot, "report-gui");
      // 保留模型快取（省下 300MB 下載），但清掉資料庫：同一個資料夾不能加入兩次，
      // 清掉才讓這個子命令可以重複跑。要驗「首次下載」請改用乾淨的 userData 或 interrupt。
      await fs.rm(path.join(userData, "data"), { recursive: true, force: true });
      const scenarios = args.only ?? "bootstrap,app,agent-guide,single,browser,index,autostart,agent,tray";
      console.log(`[smoke] gui：userData=${userData}；產物=${out}；情境=${scenarios}`);
      // 追蹤 autostart 檔的出現／消失（驗收 4 的直接證據）。
      const autostartTransitions = [];
      const watcher = setInterval(() => {
        const exists = existsSync(autostartFile);
        const last = autostartTransitions[autostartTransitions.length - 1];
        if (last === undefined || last.exists !== exists) {
          autostartTransitions.push({ exists, at: new Date().toISOString() });
        }
      }, 250);
      const result = await runApp({
        executable,
        logFile: path.join(outRoot, "gui.log"),
        env: {
          ...baseEnv,
          MNEMOSHELF_DESKTOP_USER_DATA: userData,
          MNEMOSHELF_AUTOTEST: scenarios,
          MNEMOSHELF_AUTOTEST_OUT: out,
        },
      });
      clearInterval(watcher);
      const report = await fs
        .readFile(path.join(out, "report.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => null);
      summary.results.gui = {
        exitCode: result.code,
        signal: result.signal,
        reportOk: report?.ok ?? null,
        failure: report?.failure ?? null,
        steps: report?.steps?.map((step) => `${step.ok ? "✓" : "✗"} [${step.scenario}] ${step.name}：${step.detail}`) ?? [],
        authCounters: report?.environment?.authCounters ?? null,
        autostartTransitions,
        autostartFileExistsAtEnd: existsSync(autostartFile),
        bootstrapHistory: (report?.bootstrapHistory ?? []).map((state) => ({
          phase: state.phase,
          percent: state.progress?.percent ?? 0,
          loaded: state.progress?.loaded ?? 0,
          total: state.progress?.total ?? 0,
          reusedBytes: state.reusedBytes ?? 0,
          message: state.message,
        })),
      };
      if (result.code !== 0 || report?.ok !== true) summary.ok = false;
      // 出現／消失的轉移只證明 autostart 情境跑過；用 `--only` 跑子集（例如 bootstrap,index）
      // 時本來就不會碰自啟開關，記錄仍保留在報告裡，但不該拿來判定成敗。
      const scenarioList = scenarios.trim() === "all" ? ["autostart"] : scenarios.split(",").map((item) => item.trim());
      if (
        scenarioList.includes("autostart") &&
        (!autostartTransitions.some((item) => item.exists) || !autostartTransitions.some((item) => !item.exists))
      ) {
        summary.ok = false;
      }
    }

    if (command === "interrupt") {
      const userData = path.resolve(args.userData ?? path.join(outRoot, "userData-interrupt"));
      if (!args.userData) await fs.rm(userData, { recursive: true, force: true });
      const out1 = path.join(outRoot, "report-interrupt-1");
      const out2 = path.join(outRoot, "report-interrupt-2");
      const modelDir = path.join(userData, "models");
      console.log(`[smoke] interrupt：第一次跑到有進度就砍掉；userData=${userData}`);

      const first = await runApp({
        executable,
        logFile: path.join(outRoot, "interrupt-1.log"),
        env: {
          ...baseEnv,
          MNEMOSHELF_DESKTOP_USER_DATA: userData,
          MNEMOSHELF_AUTOTEST: "bootstrap",
          MNEMOSHELF_AUTOTEST_OUT: out1,
          MNEMOSHELF_AUTOTEST_KILL_AFTER_PROGRESS: "1",
        },
        killWhen: async (lines) => {
          if (lines.some((line) => line.includes("KILL_ME_NOW_SKIPPED"))) {
            throw new Error("中斷模擬沒有意義：模型已經在磁碟上（請用乾淨的 userData）");
          }
          // 只在「確實有進度」之後才考慮砍：確保中斷時已有下載完成的檔案可沿用。
          if (!lines.some((line) => /KILL_ME_NOW \{/.test(line))) return false;
          return (await dirSize(modelDir)) > 80 * 1024 * 1024;
        },
      });
      const filesAfterKill = await listFiles(modelDir);
      const tempAfterKill = filesAfterKill.filter((file) => /\.tmp\.\d+\.[0-9a-z]+$/.test(file.relPath));
      console.log(`[smoke] 中斷時的模型目錄：${filesAfterKill.length} 個檔案（暫存檔 ${tempAfterKill.length} 個）`);

      console.log("[smoke] interrupt：重新啟動，確認沿用已下載的檔案並完成");
      const second = await runApp({
        executable,
        logFile: path.join(outRoot, "interrupt-2.log"),
        env: {
          ...baseEnv,
          MNEMOSHELF_DESKTOP_USER_DATA: userData,
          MNEMOSHELF_AUTOTEST: "bootstrap,index",
          MNEMOSHELF_AUTOTEST_OUT: out2,
        },
      });
      const report2 = await fs
        .readFile(path.join(out2, "report.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => null);
      const filesAfterResume = await listFiles(modelDir);
      const tempAfterResume = filesAfterResume.filter((file) => /\.tmp\.\d+\.[0-9a-z]+$/.test(file.relPath));
      const firstProgress = (report2?.bootstrapHistory ?? []).find((state) => (state.progress?.total ?? 0) > 0);
      summary.results.interrupt = {
        firstRun: { exitCode: first.code, signal: first.signal, killed: first.killed },
        filesAfterKill: filesAfterKill.length,
        tempFilesAfterKill: tempAfterKill.map((file) => file.relPath),
        secondRun: { exitCode: second.code, reportOk: report2?.ok ?? null, failure: report2?.failure ?? null },
        reusedBytesOnResume: firstProgress?.reusedBytes ?? 0,
        removedTempFiles: report2?.steps?.find((step) => step.name === "模型就緒")?.detail ?? null,
        filesAfterResume: filesAfterResume.length,
        tempFilesAfterResume: tempAfterResume.map((file) => file.relPath),
        steps: report2?.steps?.map((step) => `${step.ok ? "✓" : "✗"} [${step.scenario}] ${step.name}：${step.detail}`) ?? [],
      };
      if (second.code !== 0 || report2?.ok !== true) summary.ok = false;
      if (tempAfterResume.length > 0) summary.ok = false;
      if (filesAfterResume.length === 0) summary.ok = false;
    }

    if (command === "headless") {
      const userData = path.resolve(args.userData ?? path.join(outRoot, "userData-headless"));
      const token = "mnemoshelf-headless-acceptance-token";
      console.log(`[smoke] headless：--headless 啟動，之後用 curl 打服務`);
      const run = spawn("xvfb-run", ["-a", "-s", "-screen 0 1440x1000x24", executable, "--headless"], {
        env: {
          ...baseEnv,
          MNEMOSHELF_DESKTOP_USER_DATA: userData,
          MNEMOSHELF_TOKEN: token,
          MNEMOSHELF_PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const lines = [];
      const stream = createWriteStream(path.join(outRoot, "headless.log"), { flags: "w" });
      for (const source of [run.stdout, run.stderr]) {
        source.on("data", (chunk) => {
          stream.write(chunk);
          for (const line of String(chunk).split("\n")) {
            if (line.trim() === "") continue;
            process.stdout.write(`${line}\n`);
            lines.push(line);
          }
        });
      }

      let health = null;
      let authorized = null;
      let unauthorized = null;
      let analyze = null;
      let exit = null;
      let receivedSignal = false;
      try {
        const startedLine = await waitForLine(lines, (line) => line.includes("Core 服務已啟動："), 120_000, "服務啟動");
        const url = startedLine.split("Core 服務已啟動：")[1].split("（")[0].trim();
        const request = async (target, withToken) => {
          const response = await fetch(`${url}${target}`, {
            ...(withToken ? { headers: { authorization: `Bearer ${token}` } } : {}),
          });
          const body = await response.text();
          return { status: response.status, body: body.slice(0, 200) };
        };
        health = await request("/health", false);
        authorized = await request("/roots", true);
        unauthorized = await request("/roots", false);
        lines.push(`[smoke] curl /health → ${health.status} ${health.body}`);
        console.log(`[smoke] curl /health → ${health.status} ${health.body}`);
        console.log(`[smoke] curl /roots（帶 token）→ ${authorized.status} ${authorized.body}`);
        console.log(`[smoke] curl /roots（不帶 token）→ ${unauthorized.status} ${unauthorized.body}`);
      } catch (error) {
        analyze = `失敗：${error instanceof Error ? error.message : String(error)}`;
      } finally {
        // 直接對 Electron 的 browser process 送 SIGTERM：驗的是應用程式自己的收尾路徑
        // （收到訊號 → 關閉服務 → 結束）。對整個行程群組送會先殺掉 xvfb-run，看不到這條路徑。
        const pid = await findBrowserProcess(executable);
        const closePromise = new Promise((resolve) => run.on("close", (code, signal) => resolve({ code, signal })));
        if (pid !== null) process.kill(pid, "SIGTERM");
        const closed = await Promise.race([
          closePromise.then(() => true),
          delay(20_000).then(() => false),
        ]);
        receivedSignal = closed;
        if (!closed) signalProcessGroup(run, "SIGKILL");
        exit = await closePromise;
      }

      stream.end();
      summary.results.headless = {
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        windowsLine: lines.find((line) => line.includes("headless：視窗數")) ?? null,
        trayLine: lines.find((line) => line.includes("系統匣圖示已建立")) ?? null,
        gracefulLine: lines.find((line) => line.includes("授權統計")) ?? null,
        closedAfterSignal: receivedSignal,
        health,
        authorized,
        unauthorized,
        error: analyze,
      };
      if (health === null || health.status !== 200) summary.ok = false;
      if (authorized === null || authorized.status !== 200) summary.ok = false;
      if (unauthorized === null || unauthorized.status !== 401) summary.ok = false;
      if (summary.results.headless.trayLine !== null) summary.ok = false;
      if (summary.results.headless.gracefulLine === null) summary.ok = false;
    }

    if (command === "hidden") {
      // M2 的回歸驗收（開機自啟那條路徑）：帶 `--hidden` 啟動時視窗必須不可見。
      // 情境本身不需要模型；沿用 gui 的 userData（快取在磁碟上時不會重新下載）。
      const userData = path.resolve(args.userData ?? path.join(outRoot, "userData-gui"));
      console.log(`[smoke] hidden：以 --hidden 啟動並斷言視窗不可見；userData=${userData}`);

      const withHidden = await runHiddenCheck({ executable, baseEnv, userData, outRoot, withHidden: true });
      console.log(`[smoke] hidden（帶 --hidden）→ 退出碼 ${withHidden.exitCode}；報告 ok=${withHidden.reportOk}`);
      for (const step of withHidden.steps) console.log(`[smoke]   ${step}`);

      // 對照組：不帶 `--hidden` 時情境的前提不成立，必須明確失敗（不能靜靜通過）。
      console.log("[smoke] hidden：不帶 --hidden 重跑同一個情境（預期：失敗）");
      const control = await runHiddenCheck({ executable, baseEnv, userData, outRoot, withHidden: false });
      console.log(`[smoke] hidden（不帶 --hidden）→ 退出碼 ${control.exitCode}；報告 ok=${control.reportOk}；failure=${control.failure}`);

      summary.results.hidden = {
        withHidden,
        control,
      };
      // 帶 `--hidden`：退出碼 0、報告通過、log 確認真的走 hidden 模式、且那一步是 ✓。
      if (withHidden.exitCode !== 0 || withHidden.reportOk !== true) summary.ok = false;
      if (withHidden.modeLine === null || !withHidden.modeLine.includes("hidden=true")) summary.ok = false;
      if (!withHidden.steps.some((step) => step.startsWith("✓ [hidden] 以 --hidden 啟動時視窗不顯示"))) summary.ok = false;
      // 對照組：非 0 退出、報告失敗、訊息要指出前提是 `--hidden`。
      if (control.exitCode === 0 || control.reportOk !== false) summary.ok = false;
      if (control.failure === null || !control.failure.includes("--hidden")) summary.ok = false;
    }
  }

  await fs.writeFile(path.join(outRoot, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log("\n[smoke] ===== 摘要 =====");
  console.log(JSON.stringify(summary.results, null, 2));
  console.log(`[smoke] 產物：${outRoot}`);
  console.log(`[smoke] 結果：${summary.ok ? "通過" : "失敗"}`);
  process.exitCode = summary.ok ? 0 : 1;
}

/**
 * 只有「直接執行這支腳本」時才跑主流程：被 `import` 時只匯出純函式，讓單元測試可以
 * 呼叫目錄／執行檔解析（見 `test/smoke-unpacked.test.ts`）。用 realpath 比對，避免
 * 以符號連結呼叫時誤判成 import。
 */
function isDirectRun() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`[smoke] 失敗：${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

export { findExecutable, findUnpackedDir };
