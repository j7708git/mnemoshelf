// Q6：在 Electron 內執行 scripts/electron-run.mjs，兩種模式都試：
//   1) ELECTRON_RUN_AS_NODE=1（Electron 的 Node runtime，headless 可用）
//   2) 真正的 main process（需要 $DISPLAY；沒有就記錄錯誤）
// 失敗時把完整 stdout/stderr 留下來，不重試、不繞過。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RESULTS_DIR, SPIKE_ROOT, jsonWrite } from "../lib/paths.mjs";

function resolveElectron() {
  const candidates = [
    path.join(SPIKE_ROOT, "node_modules", "electron", "dist", "electron"),
    path.join(SPIKE_ROOT, "node_modules", ".bin", "electron"),
    "electron",
  ];
  for (const candidate of candidates) {
    try {
      if (candidate === "electron") return candidate;
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const electronBinary = resolveElectron();
const results = { electronBinary: electronBinary ? path.relative(SPIKE_ROOT, electronBinary) : null, modes: {} };

if (!electronBinary) {
  results.error = "找不到 electron。請先執行：pnpm add -D electron@44.7.0";
  console.error(`[electron] ${results.error}`);
} else {
  const script = path.join("scripts", "electron-run.mjs");
  const control = path.join("scripts", "electron-control.mjs");
  const hasX0 = fs.existsSync("/tmp/.X11-unix/X0");
  const modes = [
    // 對照組先跑：確認這個環境的 Electron main process 能不能起來（不載入模型）
    { name: "control-run-as-node", env: { ELECTRON_RUN_AS_NODE: "1" }, args: [control], marker: "ELECTRON_CONTROL_JSON=" },
    { name: "control-main-process", env: {}, args: [control, "--main-process"], marker: "ELECTRON_CONTROL_JSON=", timeoutMs: 90 * 1000 },
    { name: "run-as-node", env: { ELECTRON_RUN_AS_NODE: "1" }, args: [script], marker: "ELECTRON_REPORT_JSON=" },
    { name: "main-process", env: {}, args: [script, "--main-process"], marker: "ELECTRON_REPORT_JSON=", timeoutMs: 150 * 1000 },
  ];
  // 這個環境沒有 DISPLAY，但本機有 X0 socket；補一個帶 DISPLAY 的 main process 嘗試，
  // 失敗（例如逾時）就記錄錯誤，不重試。
  if (!process.env.DISPLAY && hasX0) {
    modes.push({ name: "main-process-display0", env: { DISPLAY: ":0" }, args: [script, "--main-process"], marker: "ELECTRON_REPORT_JSON=", timeoutMs: 150 * 1000 });
  }
  for (const mode of modes) {
    console.log(`\n[electron] 模式 ${mode.name} …`);
    const started = Date.now();
    const child = spawnSync(electronBinary, mode.args, {
      cwd: SPIKE_ROOT,
      env: { ...process.env, ...mode.env },
      encoding: "utf8",
      timeout: mode.timeoutMs ?? 120 * 1000,
    });
    const stdout = child.stdout ?? "";
    const stderr = child.stderr ?? "";
    const match = stdout.match(new RegExp(`${mode.marker}(.*)`));
    let report = null;
    if (match) {
      try {
        report = JSON.parse(match[1]);
      } catch (error) {
        report = { parseError: String(error.message) };
      }
    }
    results.modes[mode.name] = {
      status: child.status,
      signal: child.signal,
      timedOut: child.error?.code === "ETIMEDOUT",
      wallMs: Date.now() - started,
      report,
      stderrTail: stderr.split("\n").slice(-25).join("\n"),
      stdoutTail: report ? null : stdout.split("\n").slice(-15).join("\n"),
    };
    console.log(
      `[electron] ${mode.name}: exit=${child.status} signal=${child.signal}${child.error?.code === "ETIMEDOUT" ? "（逾時）" : ""} ok=${report?.ok ?? "n/a"} ${
        report ? JSON.stringify({ textDims: report.textDims, imageDims: report.imageDims, versions: report.versions }) : `stderr=${stderr.split("\n")[0] ?? ""}`
      }`,
    );
  }
}

jsonWrite(path.join(RESULTS_DIR, "electron-q6.json"), { generatedAt: new Date().toISOString(), ...results });
console.log(`[electron] 結果寫入 results/electron-q6.json`);
