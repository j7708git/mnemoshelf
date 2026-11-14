/** Codex UserPromptSubmit 入口。失敗時不輸出、不阻擋使用者提示。 */
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  isDirectEntry,
  readHookInput,
  recallForPrompt,
} from "./hook-core.js";

const EVENT = "UserPromptSubmit";
const HOOK_TIMEOUT_MS = 2500;

interface HookOutput {
  hookSpecificOutput: { hookEventName: typeof EVENT; additionalContext: string };
}

/** 只讀取明確指定的本機連線資訊檔，再查詢本專案及全域記憶。 */
export async function runCodexRecall(
  stdin: AsyncIterable<Uint8Array | string>,
  options: { env?: NodeJS.ProcessEnv; homeDir?: string; fetchImpl?: typeof fetch } = {},
): Promise<HookOutput | null> {
  try {
    const input = await readHookInput(stdin);
    if (input?.hook_event_name !== EVENT || typeof input.prompt !== "string") return null;

    const context = await recallForPrompt({
      prompt: input.prompt,
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      env: options.env,
      homeDir: options.homeDir,
      fetchImpl: options.fetchImpl,
      healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
      searchTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
      requireExplicitRuntimeFile: true,
    });

    return context === null
      ? null
      : { hookSpecificOutput: { hookEventName: EVENT, additionalContext: context } };
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
