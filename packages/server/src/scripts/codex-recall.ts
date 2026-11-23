/** Codex UserPromptSubmit 入口。失敗時不輸出、不阻擋使用者提示。 */
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  hookStateFile,
  isDirectEntry,
  parseHookDedupeState,
  readHookInput,
  readHookState,
  recallForPromptWithMeta,
  recordHookInjections,
  resolveHookDedupeTTL,
  writeHookState,
} from "./hook-core.js";

const EVENT = "UserPromptSubmit";
const HOOK_TIMEOUT_MS = 2500;

interface HookOutput {
  hookSpecificOutput: { hookEventName: typeof EVENT; additionalContext: string };
}

/** 只讀取明確指定的本機連線資訊檔，再查詢本專案及全域記憶。 */
export async function runCodexRecall(
  stdin: AsyncIterable<Uint8Array | string>,
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    fetchImpl?: typeof fetch;
    stateDir?: string;
    clientVersion?: string;
    clientBuild?: string;
  } = {},
): Promise<HookOutput | null> {
  try {
    const input = await readHookInput(stdin);
    if (input?.hook_event_name !== EVENT || typeof input.prompt !== "string") return null;

    const env = options.env ?? process.env;
    if (env.MNEMOSHELF_AUTO_INJECT?.trim().toLowerCase() === "off") return null;
    const runtimeFile = env.MNEMOSHELF_RUNTIME_FILE?.trim();
    if (runtimeFile === undefined || !path.isAbsolute(runtimeFile)) return null;
    const ttl = resolveHookDedupeTTL(env);
    const sessionId = [input.session_id, input.conversation_id, input.thread_id]
      .find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
    const stateDir = options.stateDir ?? (env.MNEMOSHELF_HOOK_STATE_DIR?.trim() ||
      path.join(tmpdir(), "mnemoshelf-codex-hooks"));
    const stateFile = sessionId === undefined ? undefined : hookStateFile(stateDir, sessionId);
    const state = stateFile === undefined ? {} : parseHookDedupeState(await readHookState(stateFile));
    const turn = (state.turnCount ?? 0) + 1;
    if (stateFile !== undefined && ttl > 0) await writeHookState(stateFile, { ...state, turnCount: turn });

    const result = await recallForPromptWithMeta({
      callerAgent: "codex/turn",
      prompt: input.prompt,
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      env,
      homeDir: options.homeDir,
      fetchImpl: options.fetchImpl,
      healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
      searchTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
      requireExplicitRuntimeFile: true,
      clientVersion: options.clientVersion,
      clientBuild: options.clientBuild,
      lastNoticedVersionPair: state.lastNoticedVersionPair,
    }, stateFile !== undefined && ttl > 0 ? { turn, ttl, injected: state.injected } : undefined);
    if (result === null) return null;

    const hasNewInjections = ttl > 0 && result.hits.length > 0;
    if (stateFile !== undefined && (hasNewInjections || result.noticedVersionPair !== undefined)) {
      const latest = parseHookDedupeState(await readHookState(stateFile));
      await writeHookState(stateFile, {
        ...latest,
        ...(hasNewInjections ? {
          turnCount: Math.max(latest.turnCount ?? 0, turn),
          injected: recordHookInjections(latest.injected, result.hits, turn),
        } : {}),
        lastNoticedVersionPair: result.noticedVersionPair ?? latest.lastNoticedVersionPair,
      });
    }
    return { hookSpecificOutput: { hookEventName: EVENT, additionalContext: result.block } };
  } catch {
    // 不把連線資訊、提示或記憶原文寫到 stderr。
    return null;
  }
}

async function main(): Promise<void> {
  // stdin 未結束或檔案讀取卡住時也退出，留時間給 Codex 的外層逾時。
  const watchdog = setTimeout(() => process.exit(0), HOOK_TIMEOUT_MS);
  try {
    const output = await runCodexRecall(process.stdin);
    if (output !== null) {
      process.stdout.on("error", () => process.exit(0));
      await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(output)}\n`, () => resolve()));
    }
  } finally {
    clearTimeout(watchdog);
  }
}

if (isDirectEntry(import.meta.url)) {
  void main().catch(() => undefined);
}
