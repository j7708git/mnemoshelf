/** Codex Stop 入口：只保存指定回合的可見訊息；不回填歷史，失敗時靜默放行。 */
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isBlocked, isInsideRoot } from "@mnemoshelf/core";
import {
  asRecord,
  captureTurn,
  isDirectEntry,
  readHookInput,
  sanitizeRawText,
  type CaptureMessageInput,
} from "./hook-core.js";

const HOOK_TIMEOUT_MS = 3500;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_CURSOR_BYTES = 1024;
const AGENT = "codex/turn";

export interface CodexCaptureOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  /** 僅供嵌入端／測試指定；CLI 使用 CODEX_HOME 下的固定狀態目錄。 */
  stateDir?: string;
}

interface StopInput {
  sessionId: string;
  turnId: string;
  transcriptPath: string;
  cwd: string;
  lastAssistantMessage: string;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function parseStopInput(input: Record<string, unknown> | null): StopInput | null {
  if (input?.hook_event_name !== "Stop" || !validId(input.session_id) || !validId(input.turn_id)) return null;
  if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) return null;
  if (typeof input.transcript_path !== "string" || !path.isAbsolute(input.transcript_path)) return null;
  if (typeof input.last_assistant_message !== "string" || input.last_assistant_message.trim() === "") return null;
  if (typeof input.stop_hook_active !== "boolean") return null;
  return {
    sessionId: input.session_id,
    turnId: input.turn_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    lastAssistantMessage: input.last_assistant_message,
  };
}

/** 僅移除已知注入／非可見區塊；其餘文字（含首尾空白）原樣保留。 */
function visibleText(text: string): string {
  const tags = /<\s*(\/?)\s*(memory-context|system-reminder|system|developer|environment_context|thinking|reasoning|tool_use|tool_result|tool_call|tool_output|attachment|attached-file|file)\b[^>]*>/gi;
  const stack: string[] = [];
  let end = 0;
  let output = "";
  for (const match of text.matchAll(tags)) {
    if (stack.length === 0) output += text.slice(end, match.index);
    const name = match[2]!.toLowerCase();
    if (match[1] === "/") {
      if (stack[stack.length - 1] === name) stack.pop();
    } else if (!/\/\s*>$/.test(match[0])) {
      stack.push(name);
    }
    end = match.index! + match[0].length;
  }
  if (stack.length === 0) output += text.slice(end);
  return output;
}

function occurredAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

/** 不讀 response_item：其中含宿主注入，也與 item_completed 重複。 */
function parseTurn(raw: string, input: StopInput): CaptureMessageInput[] | null {
  // 沒有完整行結尾時可能正在 flush；不把半份 transcript 當成完成的回合。
  if (!raw.endsWith("\n")) return null;
  const rows = raw.split("\n").filter((line) => line.trim() !== "").map((line) => asRecord(JSON.parse(line)));
  const meta = rows[0];
  const session = asRecord(meta?.payload);
  if (meta?.type !== "session_meta" || session?.id !== input.sessionId) return null;
  if (session.session_id !== undefined && session.session_id !== input.sessionId) return null;

  let started = false;
  let finalRaw: string | null = null;
  let finalPhase: unknown;
  let finalVisible = false;
  const seen = new Map<string, string>();
  const messages: CaptureMessageInput[] = [];
  for (const row of rows) {
    if (row?.type !== "event_msg") continue;
    const payload = asRecord(row.payload);
    if (payload?.turn_id !== input.turnId) continue;
    if (payload.type === "task_started") {
      if (started) return null;
      started = true;
      continue;
    }
    if (payload.type !== "item_completed") continue;
    if (!started || payload.thread_id !== input.sessionId) return null;
    const item = asRecord(payload.item);
    if (item === null) return null;
    if (item.type !== "UserMessage" && item.type !== "AgentMessage") continue;
    if (!validId(item.id) || !Array.isArray(item.content)) return null;
    if (item.type === "AgentMessage" && item.phase !== undefined &&
        item.phase !== "commentary" && item.phase !== "final_answer") return null;

    const fingerprint = JSON.stringify(item);
    const prior = seen.get(item.id);
    if (prior !== undefined) {
      if (prior !== fingerprint) return null;
      continue;
    }
    seen.set(item.id, fingerprint);

    const role = item.type === "UserMessage" ? "user" : "assistant";
    const textType = role === "user" ? "text" : "Text";
    const parts: string[] = [];
    for (const value of item.content) {
      const part = asRecord(value);
      if (part === null || typeof part.type !== "string") return null;
      if (part.type !== textType) continue; // 圖片、附件與其他非文字內容不保存。
      if (typeof part.text !== "string" || sanitizeRawText(part.text) !== part.text) return null;
      parts.push(part.text);
    }
    const text = parts.join("");
    const content = visibleText(text);
    if (role === "user") {
      finalRaw = null;
      finalVisible = false;
    } else {
      finalRaw = text;
      finalPhase = item.phase;
      finalVisible = content.trim() !== "";
    }
    if (content.trim() === "") continue;
    messages.push({ messageId: item.id, role, content, occurredAt: occurredAt(payload.started_at_ms) });
  }
  if (!started || messages[0]?.role !== "user" || messages.at(-1)?.role !== "assistant") return null;
  // Stop 先於 task_complete 寫入。用宿主提供的最後回答核對 flush 完整性，絕不拿它補造訊息。
  if (!finalVisible || finalRaw !== input.lastAssistantMessage ||
      (finalPhase !== undefined && finalPhase !== "final_answer")) return null;
  return messages;
}

async function readTranscript(file: string, sessionsRoot: string): Promise<string | null> {
  if (path.extname(file) !== ".jsonl") return null;
  const root = await fs.realpath(sessionsRoot);
  const target = await fs.realpath(file);
  if (!isInsideRoot(root, target, false) || path.extname(target) !== ".jsonl" || isBlocked(target)) return null;
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0 || before.size > BigInt(MAX_TRANSCRIPT_BYTES)) return null;
    // 開啟後再驗路徑與檔案身分，讀取全程只用這個 handle。
    if (await fs.realpath(file) !== target || await fs.realpath(sessionsRoot) !== root) return null;
    const current = await fs.stat(target, { bigint: true });
    if (current.dev !== before.dev || current.ino !== before.ino) return null;
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) return null;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

async function captured(file: string, eventHash: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_CURSOR_BYTES) return false;
    const state = asRecord(JSON.parse(await fs.readFile(file, "utf8")));
    return state?.version === 1 && state.eventHash === eventHash && state.saved === true;
  } catch {
    return false;
  }
}

async function markCaptured(file: string, eventHash: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(temp, JSON.stringify({ version: 1, eventHash, saved: true }), { mode: 0o600, flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

/** 保存這次 Stop 的單一完整回合；服務離線、格式變動或游標異常皆回傳空物件。 */
export async function runCodexCapture(
  stdin: AsyncIterable<Uint8Array | string>,
  options: CodexCaptureOptions = {},
): Promise<Record<string, never>> {
  try {
    const input = parseStopInput(await readHookInput(stdin));
    if (input === null) return {};
    const env = options.env ?? process.env;
    const codexHome = env.CODEX_HOME ?? path.join(options.homeDir ?? homedir(), ".codex");
    const runtimeFile = env.MNEMOSHELF_RUNTIME_FILE;
    if (!path.isAbsolute(codexHome) || runtimeFile === undefined || !path.isAbsolute(runtimeFile)) return {};
    const eventHash = createHash("sha256").update(JSON.stringify([
      AGENT, path.resolve(runtimeFile), input.sessionId, input.turnId,
    ])).digest("hex");
    const stateDir = options.stateDir ?? path.join(codexHome, "mnemoshelf", "capture-cursors");
    const stateFile = path.join(stateDir, `${eventHash}.json`);
    if (await captured(stateFile, eventHash)) return {};
    const raw = await readTranscript(input.transcriptPath, path.join(codexHome, "sessions"));
    if (raw === null) return {};
    const messages = parseTurn(raw, input);
    if (messages === null) return {};
    const result = await captureTurn({
      agent: AGENT,
      sessionId: input.sessionId,
      turnId: input.turnId,
      cwd: input.cwd,
      messages,
      env,
      homeDir: options.homeDir,
      fetchImpl: options.fetchImpl,
      requireExplicitRuntimeFile: true,
    });
    // 並行觸發以伺服器事件等冪為最後防線；409 不冒充已保存，也不另造新事件。
    if (result.status === "saved") await markCaptured(stateFile, eventHash);
  } catch {
    // 不輸出路徑、原文、連線資訊或錯誤細節。
  }
  return {};
}

async function main(): Promise<void> {
  // 無論 stdin、檔案或 stdout 是否卡住，皆在宿主 timeout 前退出；無輸出亦是放行。
  const watchdog = setTimeout(() => process.exit(0), HOOK_TIMEOUT_MS);
  process.stdout.on("error", () => process.exit(0));
  try {
    await runCodexCapture(process.stdin);
    await new Promise<void>((resolve) => process.stdout.write("{}\n", () => resolve()));
  } finally {
    clearTimeout(watchdog);
  }
}

if (isDirectEntry(import.meta.url)) void main().catch(() => process.exit(0));
