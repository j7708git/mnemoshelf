#!/usr/bin/env node
// 隔離 packaged 啟動與缺 decoder 降級；不改動原本的打包目錄。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const repo = process.cwd();
const run = path.join(repo, ".tmp", "video-acceptance", "packaged-degradation", `${Date.now()}-${randomBytes(4).toString("hex")}`);
const original = path.join(repo, "packages", "desktop", "dist-app", "win-unpacked");
const token = randomBytes(32).toString("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await fs.mkdir(run, { recursive: true });
const missing = path.join(run, "missing-decoder");
const excludedBin = path.join(original, "resources", "bin");
await fs.cp(original, missing, { recursive: true, errorOnExist: true, filter: (source) => source !== excludedBin });
const report = { startedAt: new Date().toISOString(), cases: [], ok: false };

for (const [name, appDir, expected] of [["normal", original, "available"], ["missing", missing, "disabled"]]) {
  const env = { ...process.env, MNEMOSHELF_DESKTOP_USER_DATA: path.join(run, `user-data-${name}`), MNEMOSHELF_TOKEN: token, MNEMOSHELF_PORT: "0", MNEMOSHELF_AGENT_DISCOVERY: "off", MNEMOSHELF_EMBED_DEVICE: "cpu" };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "MNEMOSHELF_FFMPEG_PATH", "MNEMOSHELF_FFPROBE_PATH", "MNEMOSHELF_FFMPEG_DIR", "MNEMOSHELF_AUTOTEST"]) delete env[key];
  const child = spawn(path.join(appDir, "mnemoshelf.exe"), ["--headless", "--inspect=0"], { cwd: appDir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  child.once("close", () => { closed = true; });
  let output = "";
  const consume = (part) => { output += String(part); };
  child.stdout.on("data", consume); child.stderr.on("data", consume);
  let spawnError;
  child.on("error", (error) => { spawnError = error.message; });
  const record = { name, expected, ok: false, normalShutdown: false };
  let inspector;
  try {
    const deadline = Date.now() + 60_000;
    let url, debug;
    while (Date.now() < deadline && child.exitCode === null && !spawnError) {
      url = /Core 服務已啟動：(http:\/\/[^\s（]+)/.exec(output)?.[1];
      debug = /Debugger listening on (ws:\/\/[^\s]+)/.exec(output)?.[1];
      if (url && debug) break;
      await sleep(100);
    }
    if (!url || !debug) throw new Error(spawnError ?? "packaged 啟動或 inspector 逾時");
    const response = await fetch(new URL("/diagnostics", url), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`diagnostics HTTP ${response.status}`);
    const body = await response.json();
    record.video = body.video;
    record.isPackaged = output.includes("isPackaged=true");
    record.ok = record.isPackaged && body.video?.state === expected;
    inspector = new WebSocket(debug);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("inspector 連線逾時")), 10_000);
      inspector.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      inspector.addEventListener("error", () => { clearTimeout(timer); reject(new Error("inspector 連線失敗")); }, { once: true });
    });
    // 觸發產品既有 SIGTERM listener：取消索引、等 native drain、關閉 server 後 app.exit。
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("正常關閉指令未回應")), 10_000);
      inspector.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) reject(new Error("正常關閉指令失敗"));
        else resolve();
      });
      // 延後發出產品事件，先回傳 inspector 回應再斷開 debugger。
      inspector.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "setTimeout(() => process.emit('SIGTERM'), 100); undefined" } }));
    });
    inspector.close();
    const exitDeadline = Date.now() + 20_000;
    while (!closed && Date.now() < exitDeadline) await sleep(100);
    record.normalShutdown = closed && child.exitCode === 0 && output.includes("收到 SIGTERM：關閉服務後結束");
    record.exitCode = child.exitCode;
  } catch (error) {
    record.error = String(error?.message ?? error).replaceAll(token, "[redacted]");
  } finally {
    inspector?.close();
    if (!closed && child.pid !== undefined) {
      record.cleanupForced = true;
      const cleanup = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise((resolve) => {
        const timer = setTimeout(() => { record.cleanupHelperTimedOut = true; cleanup.kill(); resolve(); }, 10_000);
        const done = () => { clearTimeout(timer); resolve(); };
        cleanup.once("close", done); cleanup.once("error", done);
      });
      const cleanupDeadline = Date.now() + 10_000;
      while (!closed && Date.now() < cleanupDeadline) await sleep(100);
      record.cleanupClosed = closed;
    }
    await fs.writeFile(path.join(run, `${name}.log`), output.replaceAll(token, "[redacted]"));
    record.ok = record.ok && record.normalShutdown && closed && !record.cleanupForced;
    report.cases.push(record);
  }
  // 前一案例無法證明回收完成時，不啟動下一個 packaged 程序。
  if (record.cleanupClosed === false || record.cleanupHelperTimedOut) break;
}
report.ok = report.cases.length === 2 && report.cases.every((item) => item.ok);
report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(run, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, cases: report.cases, report: path.relative(repo, path.join(run, "report.json")) }));
if (!report.ok) process.exitCode = 1;
