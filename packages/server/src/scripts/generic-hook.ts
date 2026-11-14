/**
 * 通用生命週期 Hook CLI 入口：供支援 command hook 的各式 Agent Harness 透過參數或 preset 快速接入。
 *
 * 任何離線、逾時或無命中一律靜默降級、不輸出敏感資訊到 stderr，且不阻塞宿主對話。
 */
import {
  asRecord,
  isDirectEntry,
  readHookInput,
  recallForPrompt,
} from "./hook-core.js";

const HOOK_TIMEOUT_MS = 3000;

export type GenericOutputMode = "hookSpecificOutput" | "injectSteps" | "additionalContext";

export interface GenericHookCliConfig {
  preset?: string;
  eventName: string;
  promptField: string;
  cwdField: string;
  outputMode: GenericOutputMode;
  requireExplicitRuntimeFile: boolean;
}

const PRESETS: Record<string, Omit<GenericHookCliConfig, "preset">> = {
  codex: {
    eventName: "UserPromptSubmit",
    promptField: "prompt",
    cwdField: "cwd",
    outputMode: "hookSpecificOutput",
    requireExplicitRuntimeFile: false,
  },
  "claude-code": {
    eventName: "UserPromptSubmit",
    promptField: "prompt",
    cwdField: "cwd",
    outputMode: "hookSpecificOutput",
    requireExplicitRuntimeFile: false,
  },
  "gemini-cli": {
    eventName: "BeforeAgent",
    promptField: "prompt",
    cwdField: "cwd",
    outputMode: "hookSpecificOutput",
    requireExplicitRuntimeFile: false,
  },
  antigravity: {
    eventName: "PreInvocation",
    promptField: "lastUserInput",
    cwdField: "workspacePaths.0",
    outputMode: "injectSteps",
    requireExplicitRuntimeFile: false,
  },
  cursor: {
    eventName: "beforeSubmitPrompt",
    promptField: "prompt",
    cwdField: "workspace_roots.0",
    outputMode: "additionalContext",
    requireExplicitRuntimeFile: false,
  },
};

export function parseGenericHookArgs(argv: string[]): GenericHookCliConfig {
  let presetName: string | undefined;
  let eventName: string | undefined;
  let promptField: string | undefined;
  let cwdField: string | undefined;
  let outputMode: GenericOutputMode | undefined;
  let requireExplicitRuntimeFile = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === "--preset" && next !== undefined) {
      presetName = next.trim().toLowerCase();
      i += 1;
    } else if (arg === "--event-name" && next !== undefined) {
      eventName = next.trim();
      i += 1;
    } else if (arg === "--prompt-field" && next !== undefined) {
      promptField = next.trim();
      i += 1;
    } else if (arg === "--cwd-field" && next !== undefined) {
      cwdField = next.trim();
      i += 1;
    } else if (arg === "--output-mode" && next !== undefined) {
      if (next === "hookSpecificOutput" || next === "injectSteps" || next === "additionalContext") {
        outputMode = next;
      }
      i += 1;
    } else if (arg === "--require-runtime-file") {
      requireExplicitRuntimeFile = true;
    }
  }

  const base = (presetName !== undefined ? PRESETS[presetName] : undefined) ?? PRESETS.codex!;
  return {
    preset: presetName,
    eventName: eventName ?? base.eventName,
    promptField: promptField ?? base.promptField,
    cwdField: cwdField ?? base.cwdField,
    outputMode: outputMode ?? base.outputMode,
    requireExplicitRuntimeFile: requireExplicitRuntimeFile || base.requireExplicitRuntimeFile,
  };
}

/** 依點號路徑讀取物件或陣列元素（例如 `workspacePaths.0`）。 */
export function readFieldPath(obj: Record<string, unknown>, fieldPath: string): unknown {
  let current: unknown = obj;
  for (const part of fieldPath.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else {
      const rec = asRecord(current);
      if (rec === null) return undefined;
      current = rec[part];
    }
  }
  return current;
}

export async function runGenericRecall(
  stdin: AsyncIterable<Uint8Array | string>,
  config: GenericHookCliConfig,
  options: { env?: NodeJS.ProcessEnv; homeDir?: string; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  try {
    const input = await readHookInput(stdin);
    if (input === null) return config.outputMode === "injectSteps" ? {} : null;

    const rawPrompt = readFieldPath(input, config.promptField);
    const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
    if (prompt === "") return config.outputMode === "injectSteps" ? {} : null;

    const rawCwd = readFieldPath(input, config.cwdField);
    const cwd = typeof rawCwd === "string" ? rawCwd : undefined;

    const context = await recallForPrompt({
      callerAgent: (options.env ?? process.env).MNEMOSHELF_CALLER_AGENT?.trim() || undefined,
      prompt,
      cwd,
      env: options.env,
      homeDir: options.homeDir,
      fetchImpl: options.fetchImpl,
      requireExplicitRuntimeFile: config.requireExplicitRuntimeFile,
    });

    if (context === null) {
      return config.outputMode === "injectSteps" ? {} : null;
    }

    if (config.outputMode === "injectSteps") {
      return {
        injectSteps: [{ systemMessage: { systemMessage: context } }],
        terminationBehavior: "",
      };
    }

    if (config.outputMode === "additionalContext") {
      return { additionalContext: context };
    }

    return {
      hookSpecificOutput: {
        hookEventName: config.eventName,
        additionalContext: context,
      },
    };
  } catch {
    return config.outputMode === "injectSteps" ? {} : null;
  }
}

async function main(): Promise<void> {
  const config = parseGenericHookArgs(process.argv.slice(2));
  const watchdog = setTimeout(() => process.exit(0), HOOK_TIMEOUT_MS);
  try {
    const output = await runGenericRecall(process.stdin, config);
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
