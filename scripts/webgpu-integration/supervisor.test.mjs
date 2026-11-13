import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { supervise } from "./supervisor.mjs";

test("RSS 超限會殺掉隔離群組，監看器不留下計時器", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const result = await supervise(child, { maxRssBytes: 1, timeoutMs: 5000, intervalMs: 25 });
  assert.equal(result.memoryExceeded, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exit.signal, "SIGKILL");
  assert(result.sampledPeakRssBytes > 1);
});

test("deadline 會終止含孫行程的整個群組", { skip: process.platform === "win32" }, async () => {
  const code = "const {spawn}=require('node:child_process'); const nested=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(nested.pid); setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let nestedPid;
  child.stdout.on("data", (bytes) => { nestedPid = Number(bytes.toString().trim()); });
  const result = await supervise(child, { timeoutMs: 250, intervalMs: 25 });
  assert.equal(result.timedOut, true);
  assert.equal(result.memoryExceeded, false);
  assert.equal(result.exit.signal, "SIGKILL");
  assert(Number.isInteger(nestedPid));
  // Unix 可短暫保留 zombie；只確認沒有仍執行的孫行程。
  let state = "";
  try { state = execFileSync("ps", ["-o", "stat=", "-p", String(nestedPid)], { encoding: "utf8" }).trim(); } catch { /* 已被系統回收。 */ }
  assert(!state || state.startsWith("Z"));
});
