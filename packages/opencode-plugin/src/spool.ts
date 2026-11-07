/**
 * 原文回合的本機補送佇列。每個事件保留第一份準備好的 payload；
 * 只有服務以正確格式確認保存後才移除。舊版 spool 仍保留在原處。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { asRecord, isPositiveId, prepareSource, readMemoryPolicy } from "./raw-memory.js";
import type { RawConnection, SourceWriteRequest } from "./raw-memory.js";

type LogFn = (event: string, fields?: Record<string, string | number | boolean | null>) => void;

interface SpoolRecord {
  schemaVersion: 2;
  payload: SourceWriteRequest;
}

type SpoolRead = { kind: "raw"; record: SpoolRecord } | { kind: "legacy" | "invalid" | "missing" };

type PostResult =
  | { ok: true; duplicate: boolean; status: number }
  | { ok: false; reason: string; status?: number };

function spoolName(payload: SourceWriteRequest): string {
  const key = JSON.stringify([payload.agent, payload.sourceSession, payload.sourceTurn]);
  return `raw-${createHash("sha256").update(key).digest("hex")}.json`;
}

function parseSpool(value: unknown): SpoolRead {
  const record = asRecord(value);
  if (record?.schemaVersion === 1) return { kind: "legacy" };
  const payload = asRecord(record?.payload);
  if (
    record?.schemaVersion !== 2 || !payload ||
    typeof payload.agent !== "string" || typeof payload.sourceSession !== "string" ||
    typeof payload.sourceTurn !== "string" ||
    (payload.scope !== "global" && payload.scope !== "project") ||
    (payload.scope === "project" && typeof payload.project !== "string") ||
    !Array.isArray(payload.messages) || payload.messages.length === 0 ||
    !payload.messages.every((entry) => {
      const message = asRecord(entry);
      return message !== null &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.sourceMessage === "string" && typeof message.content === "string" &&
        (message.occurredAt === null || typeof message.occurredAt === "string");
    })
  ) return { kind: "invalid" };
  // 只允許協定所需欄位，手動修改／損壞的 spool 不會把額外資料帶到服務。
  const source = payload as unknown as SourceWriteRequest;
  return {
    kind: "raw",
    record: {
      schemaVersion: 2,
      payload: {
        agent: source.agent,
        scope: source.scope,
        ...(source.scope === "project" ? { project: source.project } : {}),
        sourceSession: source.sourceSession,
        sourceTurn: source.sourceTurn,
        messages: source.messages.map(({ sourceMessage, role, content, occurredAt }) =>
          ({ sourceMessage, role, content, occurredAt })),
      },
    },
  };
}

function fileMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function readSpool(file: string): Promise<SpoolRead> {
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return { kind: "invalid" };
      return parseSpool(JSON.parse(await handle.readFile("utf8")));
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { kind: fileMissing(error) ? "missing" : "invalid" };
  }
}

async function writeSpool(dir: string, file: string, record: SpoolRecord): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(dir)).isDirectory()) throw new Error("invalid-spool-directory");
  if (process.platform !== "win32") await fs.chmod(dir, 0o700);
  const temporary = path.join(dir, `.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // link 不覆蓋另一行程已經排入的事件；JSON 永遠以完整檔案出現。
      await fs.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
    }
    if (process.platform !== "win32") {
      const directory = await fs.open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function listSpool(dir: string): Promise<string[]> {
  try {
    if (!(await fs.lstat(dir)).isDirectory()) throw new Error("invalid-spool-directory");
    return (await fs.readdir(dir)).filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort();
  } catch (error) {
    if (fileMissing(error)) return [];
    throw error;
  }
}

async function postSource(
  connection: RawConnection,
  payload: SourceWriteRequest,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<PostResult> {
  try {
    const response = await fetchImpl(`${connection.baseUrl}/memory-sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = response.status;
    if (status === 404) return { ok: false, status, reason: "upgrade-required" };
    if (status === 413) return { ok: false, status, reason: "source-too-large" };
    if (status === 409) return { ok: false, status, reason: "source-conflict" };
    if (status !== 200 && status !== 201) return { ok: false, status, reason: "http" };

    const result = asRecord(await response.json().catch(() => null));
    const source = asRecord(result?.source);
    if (
      result?.saved !== true || !source || !isPositiveId(source.id) ||
      source.agent !== payload.agent || source.sourceSession !== payload.sourceSession ||
      source.sourceTurn !== payload.sourceTurn || source.messageCount !== payload.messages.length ||
      typeof source.chunkVersion !== "string" || source.chunkVersion === "" ||
      typeof source.createdAt !== "string" ||
      !isPositiveId(result.policyVersion) || result.duplicate !== (status === 200) ||
      typeof result.redacted !== "boolean" || typeof result.redactedCount !== "number" ||
      !Number.isSafeInteger(result.redactedCount) || result.redactedCount < 0 ||
      !Array.isArray(result.memoryIds) || !result.memoryIds.every(isPositiveId)
    ) return { ok: false, status, reason: "upgrade-required" };
    return { ok: true, status, duplicate: result.duplicate };
  } catch (error) {
    return { ok: false, reason: (error as Error | undefined)?.name === "TimeoutError" ? "timeout" : "network" };
  }
}

export function createSourceSpool(input: {
  dir: string;
  log: LogFn;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  const { dir, log, fetchImpl = fetch, timeoutMs = 5000 } = input;
  let pending = Promise.resolve();
  let lastState: string | undefined;
  const report: LogFn = (event, fields) => {
    if (event === "spool-ok" || event === "spool-deferred" || event === "spool-error") {
      lastState = typeof fields?.reason === "string" ? fields.reason : event;
    }
    log(event, fields);
  };

  // 單一行程內依序讀寫，避免補送與新事件同時處理同一份檔。
  function run<T>(task: () => Promise<T>): Promise<T> {
    const work = pending.then(task);
    pending = work.then(() => undefined, () => undefined);
    return work;
  }

  const deliver = async (file: string, payload: SourceWriteRequest, connection: RawConnection): Promise<PostResult> => {
    const result = await postSource(connection, payload, fetchImpl, timeoutMs);
    if (result.ok) {
      await fs.unlink(file).catch((error: unknown) => {
        if (!fileMissing(error)) report("spool-error", { reason: "cleanup-failed" });
      });
      report("spool-ok", { status: result.status, duplicate: result.duplicate });
    } else {
      report("spool-deferred", { reason: result.reason, status: result.status ?? null });
    }
    return result;
  };

  const add = (payload: SourceWriteRequest, getConnection: () => Promise<RawConnection | null>): Promise<void> =>
    run(async () => {
      try {
        const file = path.join(dir, spoolName(payload));
        let existing = await readSpool(file);
        const connection = await getConnection().catch(() => null);
        const policy = connection === null
          ? { ok: false as const, reason: "offline" }
          : await readMemoryPolicy(connection, fetchImpl, timeoutMs);
        if (existing.kind === "missing") {
          const prepared = prepareSource(payload, policy.ok ? policy.policy : null);
          await writeSpool(dir, file, { schemaVersion: 2, payload: prepared.payload });
          existing = await readSpool(file);
          if (prepared.redactedCount > 0) report("capture-redacted", { count: prepared.redactedCount });
        }
        if (existing.kind !== "raw") {
          report("spool-error", { reason: "spool-record-unavailable" });
          return;
        }
        if (!policy.ok || connection === null) {
          report("spool-deferred", { reason: policy.ok ? "offline" : policy.reason });
          return;
        }
        await deliver(file, existing.record.payload, connection);
      } catch {
        report("spool-error", { reason: "local-write-failed" });
      }
    });

  const flush = (getConnection: () => Promise<RawConnection | null>): Promise<void> => run(async () => {
    try {
      const names = await listSpool(dir);
      if (names.length === 0) return;
      const legacy = names.filter((name) => !name.startsWith("raw-")).length;
      if (legacy > 0) report("spool-deferred", { reason: "legacy-spool-needs-migration", count: legacy });
      const raw = names.filter((name) => name.startsWith("raw-"));
      if (raw.length === 0) return;
      const connection = await getConnection().catch(() => null);
      if (connection === null) {
        report("spool-deferred", { reason: "offline", count: raw.length });
        return;
      }
      const policy = await readMemoryPolicy(connection, fetchImpl, timeoutMs);
      if (!policy.ok) {
        report("spool-deferred", { reason: policy.reason, count: raw.length });
        return;
      }
      for (const name of raw) {
        const file = path.join(dir, name);
        const item = await readSpool(file);
        if (item.kind === "missing") continue;
        if (item.kind !== "raw") {
          report("spool-deferred", { reason: item.kind === "legacy" ? "legacy-spool-needs-migration" : "invalid-spool-record" });
          continue;
        }
        const result = await deliver(file, item.record.payload, connection);
        // 明確的內容拒絕保留該事件，其他事件仍可補送；連線／服務錯誤留到下一輪。
        if (!result.ok && ![400, 409, 413].includes(result.status ?? 0)) break;
      }
    } catch {
      report("spool-error", { reason: "local-read-failed" });
    }
  });

  return {
    add,
    flush,
    awaitIdle: () => pending,
    lastState: () => lastState,
  };
}
