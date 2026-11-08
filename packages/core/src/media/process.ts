/**
 * 外部程序執行工具：無 shell、參數陣列、Windows 不開 console、輸出上限、deadline、
 * AbortSignal、程序樹清理。只給 media adapter 與測試使用。
 */
import { spawn, type ChildProcess } from "node:child_process";

/** 被強制終止的原因（可同時多個，例如 deadline 期間又收到取消）。 */
export interface ProcessKillInfo {
  deadline: boolean;
  abort: boolean;
  outputCap: boolean;
}

export interface ProcessStartOptions {
  /** 硬 deadline（毫秒）；未給則不限。 */
  timeoutMs?: number;
  /** 取消訊號；觸發時殺程序樹。 */
  signal?: AbortSignal;
  /** stdout 上限；超過視為 outputCap 並殺程序樹。 */
  maxStdoutBytes?: number;
  /** stderr 上限；超過視為 outputCap 並殺程序樹。 */
  maxStderrBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 追加在 stdin／stdout／stderr 之後的 stdio（例如用 pipe 取得第二個 rawvideo 輸出）。 */
  extraStdio?: readonly ("pipe" | "ignore")[];
}

/** 已啟動的程序；呼叫端負責消費 stdout（或等 done）。 */
export interface StartedProcess {
  readonly child: ChildProcess;
  /** 到程序結束（close）為止；被殺時 code 可能為 null。 */
  readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly killed: ProcessKillInfo;
  /** spawn 失敗訊息（例如 ENOENT／EFTYPE）；成功啟動為 null。 */
  readonly spawnError: () => string | null;
  readonly stdoutBytes: () => number;
  readonly stdoutTruncated: () => boolean;
  readonly stderrText: () => string;
  readonly stderrBytes: () => number;
  readonly stderrTruncated: () => boolean;
  /** 主動殺程序樹（idempotent）。 */
  kill: (reason?: "deadline" | "abort" | "outputCap") => Promise<void>;
  /** 若 deadline／abort 已觸發但 caller 想自訂原因時可標記。 */
  readonly elapsedMs: () => number;
}

/** 殺程序樹：Windows 用 taskkill /T /F（不經 shell）；其他平台 SIGKILL。 */
export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      let child: ChildProcess;
      try {
        child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      } catch {
        finish();
        return;
      }
      child.once("error", finish);
      child.once("close", finish);
      setTimeout(finish, 5_000).unref?.();
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已經結束或無權限；呼叫端仍會等到 close。
  }
}

/**
 * 啟動外部程序並掛上輸出上限／deadline／取消。stdout 不緩衝（stream 由 caller 消費），
 * stderr 只保留上限內文字（解碼進度／showinfo 需要）。
 */
export function startProcess(command: string, args: readonly string[], options: ProcessStartOptions = {}): StartedProcess {
  const startedAt = Date.now();
  const killed: ProcessKillInfo = { deadline: false, abort: false, outputCap: false };
  const started = Date.now();
  let spawnErrorMessage: string | null = null;
  let stdoutByteCount = 0;
  let stdoutOver = false;
  let stderrByteCount = 0;
  let stderrOver = false;
  const stderrChunks: Buffer[] = [];
  const maxStdout = options.maxStdoutBytes ?? Number.POSITIVE_INFINITY;
  const maxStderr = options.maxStderrBytes ?? Number.POSITIVE_INFINITY;

  // Windows 對不可執行檔（EFTYPE）可能在 spawn() 同步丟錯；一律轉成 spawnError 由呼叫端映射成具名錯誤。
  let child: ChildProcess;
  let syncSpawnError: string | null = null;
  try {
    child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", ...(options.extraStdio ?? [])],
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
  } catch (error) {
    syncSpawnError = String((error as { code?: unknown }).code ?? error);
    child = null as unknown as ChildProcess;
  }

  let resolveDone!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveDone = resolve; });
  if (syncSpawnError !== null || child === null) {
    spawnErrorMessage = syncSpawnError ?? "SPAWN_FAILED";
    resolveDone({ code: null, signal: null });
    return {
      child,
      done,
      killed,
      spawnError: () => spawnErrorMessage,
      stdoutBytes: () => 0,
      stdoutTruncated: () => false,
      stderrText: () => "",
      stderrBytes: () => 0,
      stderrTruncated: () => false,
      kill: async () => {},
      elapsedMs: () => Date.now() - startedAt,
    };
  }

  let killing: Promise<void> | null = null;
  const kill = (reason?: "deadline" | "abort" | "outputCap"): Promise<void> => {
    if (reason) killed[reason] = true;
    if (killing) return killing;
    killing = killProcessTree(child.pid);
    return killing;
  };

  child.once("error", (error) => {
    spawnErrorMessage = String((error as { code?: unknown }).code ?? error);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutByteCount += chunk.length;
    if (stdoutByteCount > maxStdout && !stdoutOver) {
      stdoutOver = true;
      void kill("outputCap");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrOver) return;
    const room = maxStderr - stderrByteCount;
    if (room > 0) {
      const take = chunk.subarray(0, room);
      stderrChunks.push(Buffer.from(take));
      stderrByteCount += take.length;
    }
    if (chunk.length > room) {
      stderrOver = true;
      void kill("outputCap");
    }
  });

  const timeout = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? setTimeout(() => { void kill("deadline"); }, options.timeoutMs)
    : null;
  const onAbort = () => { void kill("abort"); };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  child.once("close", (code, signal) => {
    if (timeout) clearTimeout(timeout);
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
    resolveDone({ code, signal });
  });

  return {
    child,
    done,
    killed,
    spawnError: () => spawnErrorMessage,
    stdoutBytes: () => stdoutByteCount,
    stdoutTruncated: () => stdoutOver,
    stderrText: () => Buffer.concat(stderrChunks).toString("utf8"),
    stderrBytes: () => stderrByteCount,
    stderrTruncated: () => stderrOver,
    kill,
    elapsedMs: () => Date.now() - started,
  };
}

export interface ProcessResult {
  command: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly killed: ProcessKillInfo;
  readonly spawnError: string | null;
  readonly ms: number;
}

/** 跑一個短命程序並緩衝輸出（probe 與 -version 用；上限與 deadline 同 startProcess）。 */
export async function runProcess(command: string, args: readonly string[], options: ProcessStartOptions = {}): Promise<ProcessResult> {
  const startedAt = Date.now();
  const started = startProcess(command, args, options);
  const chunks: Buffer[] = [];
  let buffered = 0;
  const maxStdout = options.maxStdoutBytes ?? 1 * 1024 * 1024;
  started.child?.stdout?.on("data", (chunk: Buffer) => {
    if (buffered >= maxStdout) return;
    const room = maxStdout - buffered;
    const take = room >= chunk.length ? chunk : chunk.subarray(0, room);
    chunks.push(Buffer.from(take));
    buffered += take.length;
  });
  const { code, signal } = await started.done;
  return {
    command,
    code,
    signal,
    stdout: Buffer.concat(chunks),
    stderr: started.stderrText(),
    stdoutBytes: started.stdoutBytes(),
    stderrBytes: started.stderrBytes(),
    stdoutTruncated: started.stdoutTruncated(),
    stderrTruncated: started.stderrTruncated(),
    killed: started.killed,
    spawnError: started.spawnError(),
    ms: Date.now() - startedAt,
  };
}