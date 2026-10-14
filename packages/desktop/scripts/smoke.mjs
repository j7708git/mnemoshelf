#!/usr/bin/env node
/**
 * Spike 驗收輔助：在 xvfb 下啟動 `--dir` 打包產物，跑完整的
 * 「貼 token → 加入測試資料夾 → 索引 → 搜尋 → 預覽（含圖片縮圖）」流程。
 *
 * 用法（於 `packages/desktop/`）：
 *   node scripts/smoke.mjs [--sample-root <dir>] [--out <dir>] [--user-data <dir>] [--query <字串>]
 *
 * 預設用專案內乾淨的 userData（`<repo>/.tmp/desktop-spike/userData`），因此**第一次跑會下載模型
 * （約 300MB）**；之後會沿用快取。要驗證「真的是 `~/.config/<app>` 這個預設路徑」時，
 * 用 `--user-data <app.getPath('userData') 的位置>`，但該目錄不能已經加入過同一個資料夾
 * （伺服器會回 409，UI 顯示「此目錄已經加入過」）。
 *
 * 需要 `xvfb-run`（headless 的 GUI session；Electron 沒有 display 起不來）。
 * 產物：`<out>/report.json` 與各步驟截圖；同時把完整 stdout／stderr 寫到 `<out>/app.log`。
 */
import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");

function parseArgs(argv) {
  const args = { sampleRoot: null, out: null, query: null, userData: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--sample-root") args.sampleRoot = value;
    else if (key === "--out") args.out = value;
    else if (key === "--query") args.query = value;
    else if (key === "--user-data") args.userData = value;
  }
  return args;
}

/** Electron 產物裡的其他執行檔（不是應用程式本體），列出來避免誤選。 */
const NON_APP_EXECUTABLES = new Set(["chrome-sandbox", "chrome_crashpad_handler"]);

/** 找到 `--dir` 產物裡的應用程式執行檔（linux-unpacked 下的頂層執行檔）。 */
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(packageDir, "..", "..");
  const sampleRoot = path.resolve(args.sampleRoot ?? path.join(repoRoot, ".tmp", "desktop-spike", "sample-root"));
  const out = path.resolve(args.out ?? path.join(repoRoot, ".tmp", "desktop-spike", "report"));
  const query = args.query ?? "Electron 桌面打包";
  const userData = path.resolve(args.userData ?? path.join(repoRoot, ".tmp", "desktop-spike", "userData"));
  const unpacked = path.join(packageDir, "dist-app", "linux-unpacked");
  const executable = await findExecutable(unpacked);
  await fs.mkdir(out, { recursive: true });

  const env = {
    ...process.env,
    MNEMOSHELF_SPIKE_AUTOTEST: sampleRoot,
    MNEMOSHELF_SPIKE_AUTOTEST_OUT: out,
    MNEMOSHELF_SPIKE_QUERY: query,
    MNEMOSHELF_DESKTOP_USER_DATA: userData,
  };

  console.log(`[smoke] 執行檔：${executable}`);
  console.log(`[smoke] 樣本目錄：${sampleRoot}`);
  console.log(`[smoke] 產物目錄：${out}`);
  console.log(`[smoke] userData：${userData}（第一次跑會下載模型）`);

  const logFile = createWriteStream(path.join(out, "app.log"), { flags: "w" });
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1440x1000x24", executable], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    logFile.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    logFile.write(chunk);
  });

  const code = await new Promise((resolve) => child.on("close", resolve));
  logFile.end();
  console.log(`[smoke] 退出碼：${code}`);
  process.exitCode = typeof code === "number" ? code : 1;
}

main().catch((error) => {
  console.error(`[smoke] 失敗：${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
