/**
 * 寫入 `POST /memories` 與 spool（離線補送）。
 *
 * spool 契約（T3 卡 §6.3）：
 * - 目錄 `~/.dsh/mnemoshelf-spool/`（0700），檔名 `<epoch-ms>-<sha256前12>.json`；
 * - tmp＋rename 原子寫入、檔案 0600；
 * - **不含 token／url**：補送時才從 runtime.json 取當下連線；
 * - 上限 200 筆，超過丟最舊；4xx（非 429）視為永久失敗移到 `failed/`。
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SPOOL_LIMIT, WRITE_TIMEOUT_MS } from "./config.js";
import { asRecord } from "./strip.js";
import type { Connection, LogFn, MemoryWritePayload, SpoolRecord } from "./types.js";

export type PostResult =
  | { ok: true; status: number; duplicate: boolean }
  | { ok: false; status?: number; reason: "http" | "network" | "timeout" };

/** 送出一張記憶卡；200（duplicate）與 201 都算成功。 */
export async function postMemory(input: {
  connection: Connection;
  payload: MemoryWritePayload;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<PostResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? WRITE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${input.connection.baseUrl}/memories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${input.connection.token}`,
      },
      body: JSON.stringify(input.payload),
      signal: controller.signal,
    });
    if (response.status === 200 || response.status === 201) {
      let duplicate = false;
      try {
        const parsed = asRecord(await response.json());
        duplicate = parsed?.duplicate === true;
      } catch {
        // 回應不是 JSON 不影響「已寫入」的判定（狀態碼已足夠）。
      }
      return { ok: true, status: response.status, duplicate };
    }
    return { ok: false, status: response.status, reason: "http" };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** spool payload 的內容雜湊（前 12 碼 hex）；同內容不會重複入 spool。 */
export function spoolHash(payload: MemoryWritePayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Windows 沒有 POSIX 權限語意；資料夾落在使用者 profile 內。
  }
}

async function listSpoolFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort((left, right) => left.localeCompare(right));
}

/** 寫入一筆 spool；回傳檔名或 null（已存在同內容、或寫入失敗）。 */
export async function writeSpool(input: {
  dir: string;
  payload: MemoryWritePayload;
  now?: Date;
  log?: LogFn;
}): Promise<string | null> {
  const now = input.now ?? new Date();
  const hash = spoolHash(input.payload);
  try {
    await ensurePrivateDir(input.dir);
    const existing = await listSpoolFiles(input.dir);
    if (existing.some((name) => name.endsWith(`-${hash}.json`))) {
      input.log?.("spool-duplicate");
      return null;
    }

    const createdAt = now.getTime();
    const name = `${createdAt}-${hash}.json`;
    const target = path.join(input.dir, name);
    const tmp = path.join(input.dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    const record: SpoolRecord = { schemaVersion: 1, createdAt, payload: input.payload };
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
    try {
      await fs.chmod(target, 0o600);
    } catch {
      // Windows：略過。
    }

    // 上限：超過就丟最舊（檔名以 epoch 開頭，字典序即時間序）。
    const files = await listSpoolFiles(input.dir);
    if (files.length > SPOOL_LIMIT) {
      const excess = files.length - SPOOL_LIMIT;
      for (const old of files.slice(0, excess)) {
        try {
          await fs.unlink(path.join(input.dir, old));
        } catch {
          // 單筆刪不掉不影響新寫入。
        }
      }
      input.log?.("spool-trim", { removed: excess });
    }
    input.log?.("spool-write");
    return name;
  } catch {
    input.log?.("spool-error");
    return null;
  }
}

function isPayload(value: unknown): value is MemoryWritePayload {
  const record = asRecord(value);
  if (record === null) return false;
  if (typeof record.content !== "string" || record.content.trim() === "") return false;
  if (record.kind !== "fact") return false;
  if (record.scope !== "project" && record.scope !== "global") return false;
  if (record.scope === "project" && typeof record.project !== "string") return false;
  if (record.agent !== "dsh/turn") return false;
  if (typeof record.sourceSession !== "string" || record.sourceSession === "") return false;
  if (typeof record.sourceMessage !== "string" || record.sourceMessage === "") return false;
  return true;
}

function parseSpoolRecord(text: string): SpoolRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null || record.schemaVersion !== 1) return null;
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return null;
  if (!isPayload(record.payload)) return null;
  return { schemaVersion: 1, createdAt: record.createdAt, payload: record.payload };
}

async function moveToFailed(dir: string, name: string): Promise<void> {
  const failedDir = path.join(dir, "failed");
  try {
    await ensurePrivateDir(failedDir);
    await fs.rename(path.join(dir, name), path.join(failedDir, name));
  } catch {
    // 搬不動就留在原目錄，下輪再試（不會無限重試成功，但至少不消失）。
  }
}

export interface FlushResult {
  sent: number;
  duplicate: number;
  failed: number;
  deferred: number;
  remaining: number;
}

/**
 * 補送 spool。成功或 `duplicate` 刪除；4xx（非 429）移到 `failed/`；
 * 其餘（429／5xx／連線失敗／逾時）保留，並停在這裡避免風暴。
 */
export async function flushSpool(input: {
  dir: string;
  connection: Connection | null;
  log: LogFn;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  batch?: number;
}): Promise<FlushResult> {
  const files = await listSpoolFiles(input.dir);
  const result: FlushResult = {
    sent: 0,
    duplicate: 0,
    failed: 0,
    deferred: 0,
    remaining: files.length,
  };
  if (files.length === 0) return result;
  if (input.connection === null) {
    result.deferred = files.length;
    return result;
  }

  const batch = Math.max(1, input.batch ?? Number.POSITIVE_INFINITY);
  let processed = 0;
  for (const name of files) {
    if (processed >= batch) break;
    processed += 1;

    let record: SpoolRecord | null = null;
    try {
      record = parseSpoolRecord(await fs.readFile(path.join(input.dir, name), "utf8"));
    } catch {
      record = null;
    }
    if (record === null) {
      await moveToFailed(input.dir, name);
      result.failed += 1;
      input.log("spool-failed", { reason: "invalid" });
      continue;
    }

    const posted = await postMemory({
      connection: input.connection,
      payload: record.payload,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    });

    if (posted.ok) {
      try {
        await fs.unlink(path.join(input.dir, name));
      } catch {
        // 刪不掉：下一輪會是 duplicate，仍算成功。
      }
      if (posted.duplicate) result.duplicate += 1;
      else result.sent += 1;
      continue;
    }

    if (posted.reason === "http" && posted.status !== undefined) {
      if (posted.status >= 400 && posted.status < 500 && posted.status !== 429) {
        await moveToFailed(input.dir, name);
        result.failed += 1;
        input.log("spool-failed", { reason: "http", status: posted.status });
        continue;
      }
    }

    // 429／5xx／連線失敗：保留，停止本輪（服務可能整個不可用）。
    result.deferred += 1;
    break;
  }

  const left = await listSpoolFiles(input.dir);
  result.remaining = left.length;
  input.log("spool-flush", {
    sent: result.sent,
    duplicate: result.duplicate,
    failed: result.failed,
    deferred: result.deferred,
    remaining: result.remaining,
  });
  return result;
}
