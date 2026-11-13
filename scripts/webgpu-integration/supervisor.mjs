/** 監看隔離驗收子行程。Unix 呼叫端必須 spawn({ detached: true })，以便終止整個程序群組。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

export async function supervise(child, { timeoutMs = 20 * 60 * 1000, maxRssBytes = 6 * 1024 ** 3, intervalMs = 500 } = {}) {
  const observation = { timeoutMs, maxRssBytes, timedOut: false, memoryExceeded: false, sampledPeakRssBytes: null, sampleFailures: 0, samples: [] };
  let active = true;
  let sampling = null;
  function killTree() {
    if (!child.pid) return;
    if (process.platform === "win32") {
      // 不使用 shell；taskkill 的 /T 含子程序。
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5000 }, () => {});
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  async function takeSample() {
    if (!active || !child.pid || sampling) return;
    sampling = (async () => {
      try {
        if (process.platform === "win32") {
          observation.sampleFailures++;
          return; // 此輪僅支援 macOS arm64 WebGPU；Windows 不冒稱已監看 RSS。
        }
        const result = await execute("ps", ["-axo", "pid=,ppid=,pgid=,rss="], { timeout: 2000, maxBuffer: 1024 * 1024 });
        const rows = result.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 4 && row.every(Number.isFinite));
        const owned = new Set([child.pid]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const [pid, parent, group] of rows) if ((owned.has(parent) || group === child.pid) && !owned.has(pid)) { owned.add(pid); changed = true; }
        }
        const processes = rows.filter(([pid]) => owned.has(pid)).map(([pid, , , rss]) => ({ pid, rssBytes: rss * 1024 }));
        if (!processes.length) return;
        const totalRssBytes = processes.reduce((sum, item) => sum + item.rssBytes, 0);
        observation.samples.push({ atMs: performance.now(), totalRssBytes, processes });
        observation.sampledPeakRssBytes = Math.max(observation.sampledPeakRssBytes ?? 0, totalRssBytes);
        if (active && totalRssBytes > maxRssBytes) { observation.memoryExceeded = true; killTree(); }
      } catch { observation.sampleFailures++; }
    })();
    try { await sampling; } finally { sampling = null; }
  }
  const timer = setTimeout(() => { observation.timedOut = true; killTree(); }, timeoutMs);
  const sampler = setInterval(() => { void takeSample(); }, intervalMs);
  child.once("spawn", () => { void takeSample(); });
  let exit;
  try {
    exit = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error: error.name }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    active = false; clearTimeout(timer); clearInterval(sampler);
    // 正常退出也回收同群組殘留程序，避免下一案沿用前案 decoder／Electron helper。
    killTree();
    await sampling;
  }
  return { exit, ...observation };
}
