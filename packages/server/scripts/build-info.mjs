#!/usr/bin/env node
/**
 * 產生 `dist/build-info.json`：把這次 build 對應的 commit 寫進產物。
 *
 * 用途：`GET /health` 的 `build` 欄位要能回答「現在跑的是哪個 commit」，
 * 讓驗收與除錯不必猜測 dist 是哪一版。
 *
 * 解析順序：
 * 1. `git -C <repo-root> rev-parse HEAD`（正常 repo 內 build）。
 * 2. `MNEMOSHELF_BUILD_COMMIT`（git 不可用／不是 repo，例如從 tarball build）。
 * 3. `"unknown"`。
 *
 * 輸出固定只有 `{"commit":"<sha>"}`，**不寫時間戳**——同一份原始碼重跑 build
 * 應該得到完全相同的內容，避免 build marker 自己漂移。
 *
 * 寫入用同目錄 tmp＋rename，避免中斷時留下半寫的 JSON。任何錯誤都只印 warning，
 * **不讓 build 失敗**（build-info 是輔助資訊，不該擋住產物）。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const outFile = path.join(packageRoot, "dist", "build-info.json");

/** 印一則不含敏感資訊的 warning。 */
function warn(message) {
  console.warn(`[build-info] ${message}`);
}

/** 依序從 git、環境變數取得 commit；都沒有時回 `"unknown"`。 */
function resolveCommit() {
  try {
    const sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha !== "") return sha;
    warn("git rev-parse HEAD 回空字串，改用環境變數或 unknown");
  } catch {
    warn("git 不可用或不是 repo，改用環境變數或 unknown");
  }

  const fromEnv = process.env.MNEMOSHELF_BUILD_COMMIT;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  return "unknown";
}

/** 以 tmp＋rename 寫出 `{"commit":"..."}`（UTF-8、結尾換行）。 */
function writeBuildInfo(commit) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  const tmpFile = `${outFile}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpFile, `${JSON.stringify({ commit })}\n`, "utf8");
    renameSync(tmpFile, outFile);
  } catch (error) {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      // 清 tmp 失敗不影響後續處理。
    }
    throw error;
  }
}

let commit;
try {
  commit = resolveCommit();
} catch (error) {
  warn(`解析 commit 失敗（不影響 build）：${error instanceof Error ? error.message : String(error)}`);
  commit = "unknown";
}

try {
  writeBuildInfo(commit);
} catch (error) {
  warn(`寫入 dist/build-info.json 失敗（不影響 build）：${error instanceof Error ? error.message : String(error)}`);
  // 最後嘗試寫 unknown：至少讓 /health 有可辨識的值（若仍失敗就放棄，build 照樣成功）。
  try {
    writeBuildInfo("unknown");
  } catch {
    warn("連 unknown 都寫不進去，略過 build marker");
  }
}
