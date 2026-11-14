/**
 * Antigravity 生命週期 Hook Adapter：
 * - `pre-invocation`：對應 `PreInvocation`，於每輪新提問自動召回相關記憶並以 systemMessage 注入。
 * - `stop`：對應 `Stop`，於回合正常結束時從 `transcript.jsonl` 解析可見對話並等冪寫入原文記憶。
 *
 * 任何離線、逾時或格式異常一律回傳 `{}`，絕不阻塞宿主對話。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  asRecord,
  captureTurn,
  isDirectEntry,
  readHookInput,
  recallForPrompt,
  type CaptureMessageInput,
} from "./hook-core.js";

const HOOK_TIMEOUT_MS = 3500;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_FULL_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const EXPLICIT_MEMORY_HINT_RE =
  /記得|上次|之前|過去|回憶|記憶|remember|recall|previous|earlier|last\s+time/iu;
const SKIP_STOP_REASONS = new Set(["ERROR", "USER_CANCELED", "TERMINAL_CUSTOM_HOOK"]);

export interface PreInvocationOutput {
  injectSteps?: Array<{ systemMessage: { systemMessage: string } }>;
  terminationBehavior?: string;
}

export type StopOutput = Record<string, never>;

interface ConversationState {
  lastPromptHash?: string;
  lastCapturedUserStepIndex?: number;
}

interface ParsedStep {
  stepIndex: number;
  source: string;
  type: string;
  status: string;
  createdAt: string | null;
  content: string;
  contentTruncated: boolean;
}

interface ParsedTurn {
  userStep: ParsedStep;
  assistantSteps: ParsedStep[];
}

export interface AntigravityHookOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  stateDir?: string;
}

function resolveWorkspaceCwd(input: Record<string, unknown>): string | undefined {
  const paths = input.workspacePaths;
  if (!Array.isArray(paths)) return undefined;
  for (const item of paths) {
    if (typeof item === "string" && path.isAbsolute(item)) return item;
  }
  return undefined;
}

function resolveStateFile(conversationId: string, options: AntigravityHookOptions): string {
  const env = options.env ?? process.env;
  const baseDir =
    options.stateDir ??
    (env.PLUGIN_DATA?.trim()
      ? path.join(env.PLUGIN_DATA.trim(), "mnemoshelf-state")
      : path.join(tmpdir(), "mnemoshelf-antigravity-hooks"));
  const hash = createHash("sha256").update(conversationId).digest("hex");
  return path.join(baseDir, `${hash}.json`);
}

async function readState(file: string): Promise<ConversationState> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = asRecord(JSON.parse(raw));
    if (parsed === null) return {};
    return {
      lastPromptHash: typeof parsed.lastPromptHash === "string" ? parsed.lastPromptHash : undefined,
      lastCapturedUserStepIndex:
        typeof parsed.lastCapturedUserStepIndex === "number" &&
        Number.isSafeInteger(parsed.lastCapturedUserStepIndex)
          ? parsed.lastCapturedUserStepIndex
          : undefined,
    };
  } catch {
    return {};
  }
}

async function writeState(file: string, state: ConversationState): Promise<void> {
  try {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
  } catch {
    // 狀態檔寫入失敗不應影響主流程
  }
}

/** 處理 Antigravity `PreInvocation` 事件。 */
export async function runAntigravityPreInvocation(
  stdin: AsyncIterable<Uint8Array | string>,
  options: AntigravityHookOptions = {},
): Promise<PreInvocationOutput> {
  const env = options.env ?? process.env;
  try {
    const input = await readHookInput(stdin);
    if (input === null) return {};

    const prompt = typeof input.lastUserInput === "string" ? input.lastUserInput.trim() : "";
    if (prompt === "") return {};

    const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
    const recallMode = env.MNEMOSHELF_RECALL_MODE?.trim() || "first-turn+explicit";
    const stateFile = conversationId !== "" ? resolveStateFile(conversationId, options) : null;
    const state = stateFile !== null ? await readState(stateFile) : {};
    const promptHash = createHash("sha256").update(prompt).digest("hex");

    if (recallMode !== "every-turn" && stateFile !== null) {
      const isNewPrompt = state.lastPromptHash !== promptHash;
      const hasExplicitHint = EXPLICIT_MEMORY_HINT_RE.test(prompt);
      if (!isNewPrompt && !hasExplicitHint) return {};
    }

    if (stateFile !== null && state.lastPromptHash !== promptHash) {
      await writeState(stateFile, { ...state, lastPromptHash: promptHash });
    }

    const cwd = resolveWorkspaceCwd(input);
    const context = await recallForPrompt({
      callerAgent: "antigravity/turn",
      prompt,
      cwd,
      env,
      homeDir: options.homeDir,
      fetchImpl: options.fetchImpl,
    });
    if (context === null) return {};

    return {
      injectSteps: [{ systemMessage: { systemMessage: context } }],
      terminationBehavior: "",
    };
  } catch {
    return {};
  }
}

function parseTranscriptLine(line: string): ParsedStep | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const obj = asRecord(raw);
  if (obj === null) return null;
  if (typeof obj.step_index !== "number" || !Number.isSafeInteger(obj.step_index)) return null;
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type !== "USER_INPUT" && type !== "PLANNER_RESPONSE") return null;

  const source = typeof obj.source === "string" ? obj.source : "";
  if (source === "SYSTEM") return null;

  const status = typeof obj.status === "string" ? obj.status : "DONE";
  const createdAt = typeof obj.created_at === "string" ? obj.created_at : null;
  const content = typeof obj.content === "string" ? obj.content : "";
  const truncatedFields = Array.isArray(obj.truncated_fields) ? obj.truncated_fields : [];
  const contentTruncated = truncatedFields.includes("content");

  return {
    stepIndex: obj.step_index,
    source,
    type,
    status,
    createdAt,
    content,
    contentTruncated,
  };
}

async function readFullContentMap(
  transcriptPath: string,
  neededIndices: Set<number>,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (neededIndices.size === 0) return result;
  const fullPath = path.join(path.dirname(transcriptPath), "transcript_full.jsonl");
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile() || stat.size > MAX_FULL_TRANSCRIPT_BYTES) return result;
    const raw = await fs.readFile(fullPath, "utf8");
    for (const line of raw.split("\n")) {
      const step = parseTranscriptLine(line);
      if (step !== null && neededIndices.has(step.stepIndex) && step.content.trim() !== "") {
        result.set(step.stepIndex, step.content);
      }
    }
  } catch {
    // 讀不到 transcript_full.jsonl 時靜默退回原內容
  }
  return result;
}

/** 從 Antigravity transcript.jsonl 解析出已完成的使用者與助理可見對話回合。 */
export async function parseAntigravityTurns(transcriptPath: string): Promise<ParsedTurn[]> {
  const stat = await fs.stat(transcriptPath);
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return [];

  const raw = await fs.readFile(transcriptPath, "utf8");
  const steps: ParsedStep[] = [];
  const truncatedIndices = new Set<number>();

  for (const line of raw.split("\n")) {
    const step = parseTranscriptLine(line);
    if (step === null) continue;
    if (step.status !== "DONE") continue;
    if (step.contentTruncated) truncatedIndices.add(step.stepIndex);
    steps.push(step);
  }

  const fullMap = await readFullContentMap(transcriptPath, truncatedIndices);
  for (const step of steps) {
    const full = fullMap.get(step.stepIndex);
    if (full !== undefined) step.content = full;
  }

  const turns: ParsedTurn[] = [];
  let current: ParsedTurn | null = null;

  for (const step of steps) {
    const text = step.content.trim();
    if (step.type === "USER_INPUT") {
      if (text === "") continue;
      current = { userStep: step, assistantSteps: [] };
      turns.push(current);
    } else if (step.type === "PLANNER_RESPONSE" && current !== null) {
      if (text === "") continue;
      current.assistantSteps.push(step);
    }
  }

  return turns.filter((turn) => turn.assistantSteps.length > 0);
}

/** 處理 Antigravity `Stop` 事件。 */
export async function runAntigravityStop(
  stdin: AsyncIterable<Uint8Array | string>,
  options: AntigravityHookOptions = {},
): Promise<StopOutput> {
  const env = options.env ?? process.env;
  try {
    const input = await readHookInput(stdin);
    if (input === null) return {};

    const reason = typeof input.terminationReason === "string" ? input.terminationReason : "";
    if (SKIP_STOP_REASONS.has(reason)) return {};

    const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
    const transcriptPath = typeof input.transcriptPath === "string" ? input.transcriptPath.trim() : "";
    if (conversationId === "" || transcriptPath === "" || !path.isAbsolute(transcriptPath)) return {};

    const turns = await parseAntigravityTurns(transcriptPath);
    if (turns.length === 0) return {};

    const stateFile = resolveStateFile(conversationId, options);
    let state = await readState(stateFile);
    let lastCaptured = state.lastCapturedUserStepIndex ?? -1;
    const cwd = resolveWorkspaceCwd(input);

    for (const turn of turns) {
      if (turn.userStep.stepIndex <= lastCaptured) continue;

      const assistantText = turn.assistantSteps.map((s) => s.content.trim()).join("\n\n");
      const lastAssistant = turn.assistantSteps[turn.assistantSteps.length - 1]!;
      const messages: CaptureMessageInput[] = [
        {
          messageId: `step-${turn.userStep.stepIndex}`,
          role: "user",
          content: turn.userStep.content,
          occurredAt: turn.userStep.createdAt,
        },
        {
          messageId: `step-${lastAssistant.stepIndex}`,
          role: "assistant",
          content: assistantText,
          occurredAt: lastAssistant.createdAt,
        },
      ];

      const result = await captureTurn({
        agent: "antigravity/turn",
        sessionId: conversationId,
        turnId: `turn-${turn.userStep.stepIndex}`,
        cwd,
        messages,
        env,
        homeDir: options.homeDir,
        fetchImpl: options.fetchImpl,
      });

      if (result.status === "offline") break;
      if (result.status === "saved" || result.status === "conflict") {
        lastCaptured = turn.userStep.stepIndex;
        state = { ...state, lastCapturedUserStepIndex: lastCaptured };
        await writeState(stateFile, state);
      }
    }

    return {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const watchdog = setTimeout(() => {
    process.stdout.write("{}\n", () => process.exit(0));
  }, HOOK_TIMEOUT_MS);

  try {
    const output =
      mode === "pre-invocation"
        ? await runAntigravityPreInvocation(process.stdin)
        : mode === "stop"
          ? await runAntigravityStop(process.stdin)
          : {};
    process.stdout.on("error", () => process.exit(0));
    await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(output)}\n`, () => resolve()));
  } finally {
    clearTimeout(watchdog);
  }
}

if (isDirectEntry(import.meta.url)) {
  void main().catch(() => {
    process.stdout.write("{}\n", () => process.exit(0));
  });
}
