/**
 * `agent-guide-reader.ts`（卡 2 的讀檔層）測試。
 *
 * 全部用 `fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-agent-guide-"))` 建的暫存目錄：
 * 不碰真實的 `~/.config/opencode`、`~/.codex`、`~/.dsh`，也不依賴任何使用者資料。
 *
 * 測的三件事：
 * 1. 讀檔規則（stat 的各種失敗、too-large、合併掃描、plugins／profiles 列舉與上限）；
 * 2. `copy.blocked` 只放被 `copyGate` 擋下的 kind；
 * 3. 隱私與同源：token／environment 不進回傳，`previews` 與 `buildCopyText` 逐字相同。
 *
 * 另外用靜態對照守著 IPC 契約（主程序不能被 vitest 直接載入，含 Electron）：
 * 通道名稱、API 版本、preload 鏡像，以及 main.ts 不再自行組片段。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_GUIDE_COPY_KINDS,
  MAX_AGENT_GUIDE_CONFIG_BYTES,
  buildCopyText,
  codexConfigPaths,
  copyGate,
  dshProfilesDir,
  opencodeConfigCandidates,
  opencodePluginsDir,
  type AgentGuideConnection,
} from "../src/agent-guide.js";
import { readAgentGuideState } from "../src/agent-guide-reader.js";
import { DESKTOP_API_VERSION, DESKTOP_CHANNELS, type DesktopAgentGuideCopyResult, type DesktopAgentGuideState, type DesktopBridge } from "../src/desktop-api.js";

/** 合成 token（只寫進暫存檔，測試檔本身不含任何真實憑證）。 */
const SYNTHETIC_TOKEN = "synthetic-token-not-a-real-credential";
/** 固定偵測時間，讓 `detectedAt` 可斷言。 */
const NOW = new Date("2026-10-29T00:00:00.000Z");

let root: string;
let home: string;
let runtimeFile: string;
let entryPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-agent-guide-"));
  home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  runtimeFile = path.join(root, "userdata", "data", "runtime.json");
  entryPath = path.join(root, "server", "dist", "scripts", "mcp.js");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

interface ReadOverrides {
  env?: { DSH_HOME?: string };
  appImage?: string;
  now?: () => Date;
}

/** 以預設的暫存路徑呼叫讀檔器。 */
async function readState(overrides: ReadOverrides = {}): Promise<DesktopAgentGuideState> {
  return readAgentGuideState({
    home,
    env: overrides.env ?? {},
    appImage: overrides.appImage,
    runtimeFile,
    entryPath,
    now: overrides.now ?? (() => NOW),
  });
}

async function writeTextFile(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function writeJsonFile(target: string, value: unknown): Promise<void> {
  await writeTextFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

/** 建立「連線資訊檔」（內容含 token，用來驗「token 不進回傳」）。 */
async function createRuntimeFile(): Promise<void> {
  await writeJsonFile(runtimeFile, {
    url: "http://127.0.0.1:3917",
    token: SYNTHETIC_TOKEN,
  });
}

/** 建立「MCP 入口腳本」（只要存在且是一般檔案即可）。 */
async function createEntryFile(): Promise<void> {
  await writeTextFile(entryPath, "// synthetic mcp entry\n");
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** 需要 runtime.json 的 kind（卡 1 的 `copyGate` 定義）。 */
const RUNTIME_BLOCKED_KINDS = [
  "opencode-mcp",
  "mcp-generic",
  "codex-mcp",
  "install-card-opencode",
  "install-card-codex",
  "install-card-dsh",
  "install-card-generic",
] as const;

/** 需要 MCP 入口的 kind（同時受 AppImage 影響）。 */
const ENTRY_BLOCKED_KINDS = [
  "opencode-mcp",
  "mcp-generic",
  "codex-mcp",
  "install-card-codex",
  "install-card-generic",
] as const;

describe("readAgentGuideState：什麼都沒有", () => {
  it("三個 harness 都是 not-detected／file-missing，detectedAt 用注入的時間", async () => {
    const state = await readState();

    expect(state.detectedAt).toBe(NOW.toISOString());
    expect(state.runtimeFile).toBe(runtimeFile);
    expect(state.entryPath).toBe(entryPath);

    // opencode：兩個設定候選都不存在；plugins/ 目錄不存在（不傳輸入）。
    expect(state.detection.opencode.state).toBe("not-detected");
    expect(state.detection.opencode.reason).toBe("file-missing");
    expect(state.detection.opencode.sourcesChecked).toBe(2);
    // codex：config.toml 與 hooks.json 各一筆。
    expect(state.detection.codex.state).toBe("not-detected");
    expect(state.detection.codex.reason).toBe("file-missing");
    expect(state.detection.codex.sourcesChecked).toBe(2);
    // dsh：profiles 根目錄不存在 → 空陣列。
    expect(state.detection.dsh.state).toBe("not-detected");
    expect(state.detection.dsh.reason).toBe("file-missing");
    expect(state.detection.dsh.sourcesChecked).toBe(0);
  });

  it("copy.blocked 只放被 copyGate 擋下的 kind（runtime 缺 → 7 個 runtime-missing）", async () => {
    const state = await readState();

    // 與閘門逐格對照：reader 只負責把 allowed=false 的原因放進 map。
    const expected = Object.fromEntries(
      AGENT_GUIDE_COPY_KINDS.map((kind) => {
        const decision = copyGate({ kind, appImage: undefined, runtimeFileExists: false, entryPathExists: false });
        return [kind, decision] as const;
      })
        .filter(([, decision]) => !decision.allowed)
        .map(([kind, decision]) => [kind, decision.reason]),
    );
    expect(state.copy.blocked).toEqual(expected);
    expect(sorted(Object.keys(state.copy.blocked))).toEqual(sorted(RUNTIME_BLOCKED_KINDS));
    for (const reason of Object.values(state.copy.blocked)) {
      expect(reason).toBe("runtime-missing");
    }
    // 這兩個 kind 不需要 runtime：可以複製，因此**不出現在 map 裡**（不是存 null）。
    expect(state.copy.blocked["opencode-plugins"]).toBeUndefined();
    expect(state.copy.blocked["dsh-profile"]).toBeUndefined();
  });
});

describe("讀檔規則", () => {
  it("設定檔路徑被目錄佔用（非一般檔案）→ file-missing，不是錯誤", async () => {
    const [firstCandidate] = opencodeConfigCandidates(home);
    await fs.mkdir(firstCandidate!, { recursive: true });

    const state = await readState();
    expect(state.detection.opencode.state).toBe("not-detected");
    expect(state.detection.opencode.reason).toBe("file-missing");
  });

  it("其他 stat 錯誤（ENOTDIR）→ read-error／unknown，不能降級成未偵測到", async () => {
    // 把 `.config/opencode` 變成一般檔案：兩個候選與 plugins/ 的 stat／readdir 都會 ENOTDIR。
    await writeTextFile(path.join(home, ".config", "opencode"), "not a directory\n");

    const state = await readState();
    expect(state.detection.opencode.state).toBe("unknown");
    expect(state.detection.opencode.reason).toBe("read-error");
  });

  it("超過 1 MiB（1 MiB + 1 byte）→ unknown／too-large，不是 not-detected", async () => {
    const [firstCandidate] = opencodeConfigCandidates(home);
    await writeTextFile(firstCandidate!, "");
    // 先寫小檔再 `truncate` 放大，避免真的在記憶體組 1 MiB 字串。
    await fs.truncate(firstCandidate!, MAX_AGENT_GUIDE_CONFIG_BYTES + 1);

    const state = await readState();
    expect(state.detection.opencode.state).toBe("unknown");
    expect(state.detection.opencode.reason).toBe("too-large");
    // codex／dsh 不受影響。
    expect(state.detection.codex.state).toBe("not-detected");
    expect(state.detection.dsh.state).toBe("not-detected");
  });

  it("合併掃描：第一個候選沒有、第二個有 → detected（不得 first-hit-wins）", async () => {
    const [jsonc, json] = opencodeConfigCandidates(home);
    await writeJsonFile(jsonc!, { $schema: "https://opencode.ai/config.json" });
    await writeJsonFile(json!, { plugins: ["<REPO_DIR>/packages/mnemoshelf-plugin"] });

    const state = await readState();
    expect(state.detection.opencode.state).toBe("detected");
    expect(state.detection.opencode.reason).toBe("ok");
    expect(state.detection.opencode.sourcesChecked).toBe(2);
  });

  it("正面證據優先：第一個候選命中、第二個壞掉 → 仍 detected（不是 unknown）", async () => {
    const [jsonc, json] = opencodeConfigCandidates(home);
    await writeJsonFile(jsonc!, { plugins: ["<REPO_DIR>/packages/mnemoshelf-plugin"] });
    await writeTextFile(json!, "{ this is not json");

    const state = await readState();
    expect(state.detection.opencode.state).toBe("detected");
    expect(state.detection.opencode.matches.length).toBeGreaterThan(0);
  });

  it("plugins 目錄：目錄的 package.json name 含 mnemoshelf → detected，matches 只有路徑", async () => {
    const pluginsDir = opencodePluginsDir(home);
    const itemDir = path.join(pluginsDir, "mnemoshelf-local");
    await writeJsonFile(path.join(itemDir, "package.json"), {
      name: "@mnemoshelf/opencode-plugin",
      // options 內容（可能藏 token）不得出現在回傳。
      options: { token: SYNTHETIC_TOKEN },
    });

    const state = await readState();
    expect(state.detection.opencode.state).toBe("detected");
    expect(state.detection.opencode.matches).toEqual([itemDir]);
    expect(JSON.stringify(state)).not.toContain(SYNTHETIC_TOKEN);
  });

  it("plugins 目錄：沒有 package.json 的目錄仍以路徑命中（opencode-plugin）", async () => {
    const pluginsDir = opencodePluginsDir(home);
    const itemDir = path.join(pluginsDir, "opencode-plugin");
    await fs.mkdir(itemDir, { recursive: true });

    const state = await readState();
    expect(state.detection.opencode.state).toBe("detected");
    expect(state.detection.opencode.matches).toEqual([itemDir]);
  });

  it("plugins 目錄：檔案項目直接讀它本身", async () => {
    const pluginsDir = opencodePluginsDir(home);
    const filePath = path.join(pluginsDir, "single-mnemoshelf-plugin.js");
    await writeTextFile(filePath, "export default {};\n");

    const state = await readState();
    expect(state.detection.opencode.state).toBe("detected");
    expect(state.detection.opencode.matches).toEqual([filePath]);
    expect(state.detection.opencode.sourcesChecked).toBe(3); // 2 個設定 + 1 個檔案項目
  });

  it("plugins 目錄列舉失敗（它是一般檔案）→ unknown／read-error", async () => {
    await writeTextFile(opencodePluginsDir(home), "not a directory\n");

    const state = await readState();
    expect(state.detection.opencode.state).toBe("unknown");
    expect(state.detection.opencode.reason).toBe("read-error");
    expect(state.detection.opencode.sourcesChecked).toBe(3); // 2 個設定 + 1 筆列舉失敗
  });

  it("plugins 目錄最多讀 50 個項目（名稱排序取前 50）", async () => {
    const pluginsDir = opencodePluginsDir(home);
    // 50 個不相關的目錄（沒有 package.json）；名稱都排在 zz 前面。
    for (let index = 0; index < 50; index += 1) {
      await fs.mkdir(path.join(pluginsDir, `item-${String(index).padStart(2, "0")}`), { recursive: true });
    }
    // 第 51 個：被上限排除，不該被讀到（即使它的路徑也含 mnemoshelf）。
    const lateDir = path.join(pluginsDir, "zz-mnemoshelf");
    await writeJsonFile(path.join(lateDir, "package.json"), { name: "@mnemoshelf/opencode-plugin" });

    const capped = await readState();
    // 2 個設定 + 只讀 50 個外掛項目（不是 51）。
    expect(capped.detection.opencode.sourcesChecked).toBe(52);
    expect(capped.detection.opencode.matches).toHaveLength(50);
    expect(capped.detection.opencode.matches).not.toContain(lateDir);

    // 對照組：排序最前面的新目錄進得了前 50，原本第 50 個（item-49）被擠出。
    const earlyDir = path.join(pluginsDir, "aa-mnemoshelf");
    await writeJsonFile(path.join(earlyDir, "package.json"), { name: "@mnemoshelf/opencode-plugin" });
    const found = await readState();
    expect(found.detection.opencode.matches).toContain(earlyDir);
    expect(found.detection.opencode.matches).toHaveLength(50);
    expect(found.detection.opencode.matches).not.toContain(path.join(pluginsDir, "item-49"));
    expect(found.detection.opencode.matches).not.toContain(lateDir);
  });

  it("codex：config.toml 的 [mcp_servers.mnemoshelf] 算偵測到", async () => {
    const paths = codexConfigPaths(home);
    await writeTextFile(paths.config, '[mcp_servers.mnemoshelf]\ncommand = "synthetic"\n');

    const state = await readState();
    expect(state.detection.codex.state).toBe("detected");
    expect(state.detection.codex.mcpConfigured).toBe(true);
    expect(state.detection.codex.hookConfigured).toBe(false);
    expect(state.detection.codex.matches).toEqual([]);
  });

  it("codex：hooks.json 有含 mnemoshelf 的字串也算偵測到（兩份都會讀）", async () => {
    const paths = codexConfigPaths(home);
    await writeJsonFile(paths.hooks, {
      hooks: { stop: [{ command: "node <REPO_DIR>/packages/mnemoshelf/recall.mjs" }] },
    });

    const state = await readState();
    expect(state.detection.codex.state).toBe("detected");
    expect(state.detection.codex.hookConfigured).toBe(true);
    expect(state.detection.codex.sourcesChecked).toBe(2);
  });

  it("dsh：profiles/web/package.json 的 dsh.profile.bundles → detected、matches 含 web", async () => {
    const profilesDir = dshProfilesDir({ home, env: {} });
    await writeJsonFile(path.join(profilesDir, "web", "package.json"), {
      dsh: { profile: { bundles: ["@mnemoshelf/dsh-plugin"] } },
    });

    const state = await readState();
    expect(state.detection.dsh.state).toBe("detected");
    expect(state.detection.dsh.matches).toEqual(["web"]);
  });

  it("dsh：DSH_HOME 非空時只讀 $DSH_HOME/profiles；空白視為未指定", async () => {
    // home 底下有一份命中的 profile（只有在 DSH_HOME 空白時才會被讀到）。
    const homeProfiles = dshProfilesDir({ home, env: {} });
    await writeJsonFile(path.join(homeProfiles, "home-profile", "package.json"), {
      dsh: { profile: { bundles: ["@mnemoshelf/dsh-plugin"] } },
    });

    const customHome = path.join(root, "custom-dsh");
    await writeJsonFile(path.join(customHome, "profiles", "web", "package.json"), {
      dependencies: { "@mnemoshelf/dsh-plugin": "link:<REPO_DIR>/packages/dsh-plugin" },
    });

    const overridden = await readState({ env: { DSH_HOME: customHome } });
    expect(overridden.detection.dsh.matches).toEqual(["web"]);

    const blank = await readState({ env: { DSH_HOME: "   " } });
    expect(blank.detection.dsh.matches).toEqual(["home-profile"]);
  });

  it("dsh：profile 目錄存在但沒有 package.json → file-missing（不是錯誤）", async () => {
    const profilesDir = dshProfilesDir({ home, env: {} });
    await fs.mkdir(path.join(profilesDir, "empty-profile"), { recursive: true });

    const state = await readState();
    expect(state.detection.dsh.state).toBe("not-detected");
    expect(state.detection.dsh.reason).toBe("file-missing");
    expect(state.detection.dsh.sourcesChecked).toBe(1);
    expect(state.detection.dsh.matches).toEqual([]);
  });

  it("dsh：profiles 根目錄列舉失敗（它是一般檔案）→ unknown／read-error", async () => {
    const profilesDir = dshProfilesDir({ home, env: {} });
    await writeTextFile(profilesDir, "not a directory\n");

    const state = await readState();
    expect(state.detection.dsh.state).toBe("unknown");
    expect(state.detection.dsh.reason).toBe("read-error");
    // 失敗的列舉是一筆來源；profile 名稱不是路徑。
    expect(state.detection.dsh.sourcesChecked).toBe(1);
    expect(state.detection.dsh.matches).toEqual([]);
  });

  it("dsh：profiles 最多讀 50 個子目錄（名稱排序取前 50）", async () => {
    const profilesDir = dshProfilesDir({ home, env: {} });
    for (let index = 0; index < 50; index += 1) {
      await fs.mkdir(path.join(profilesDir, `p-${String(index).padStart(2, "0")}`), { recursive: true });
    }
    // 排序最後的第 51 個：被上限排除。
    await writeJsonFile(path.join(profilesDir, "zz-case", "package.json"), {
      dsh: { profile: { bundles: ["@mnemoshelf/dsh-plugin"] } },
    });

    const capped = await readState();
    expect(capped.detection.dsh.state).not.toBe("detected");
    expect(capped.detection.dsh.matches).toEqual([]);

    // 對照組：排序最前面的命中 profile 進得了前 50。
    await writeJsonFile(path.join(profilesDir, "aa-case", "package.json"), {
      dsh: { profile: { bundles: ["@mnemoshelf/dsh-plugin"] } },
    });
    const found = await readState();
    expect(found.detection.dsh.state).toBe("detected");
    expect(found.detection.dsh.matches).toEqual(["aa-case"]);
  });
});

describe("copy.blocked 擋下矩陣", () => {
  it("runtime 缺、入口在 → 只有需要 runtime 的 7 個 kind 被擋（runtime-missing）", async () => {
    await createEntryFile();

    const state = await readState();
    expect(sorted(Object.keys(state.copy.blocked))).toEqual(sorted(RUNTIME_BLOCKED_KINDS));
    for (const kind of RUNTIME_BLOCKED_KINDS) {
      expect(state.copy.blocked[kind]).toBe("runtime-missing");
    }
  });

  it("runtime 在、入口缺 → 只有需要入口的 5 個 kind 被擋（entry-missing）", async () => {
    await createRuntimeFile();

    const state = await readState();
    expect(sorted(Object.keys(state.copy.blocked))).toEqual(sorted(ENTRY_BLOCKED_KINDS));
    for (const kind of ENTRY_BLOCKED_KINDS) {
      expect(state.copy.blocked[kind]).toBe("entry-missing");
    }
  });

  it("兩個檔案都在、AppImage → 需要入口的 5 個 kind 被擋（appimage）", async () => {
    await createRuntimeFile();
    await createEntryFile();

    const state = await readState({ appImage: path.join(root, "synthetic", "Mnemoshelf.AppImage") });
    expect(sorted(Object.keys(state.copy.blocked))).toEqual(sorted(ENTRY_BLOCKED_KINDS));
    for (const kind of ENTRY_BLOCKED_KINDS) {
      expect(state.copy.blocked[kind]).toBe("appimage");
    }
  });

  it("兩個檔案都在、不是 AppImage → 沒有任何 kind 被擋", async () => {
    await createRuntimeFile();
    await createEntryFile();

    const state = await readState();
    expect(state.copy.blocked).toEqual({});
  });
});

describe("隱私與同源", () => {
  it("token／environment 的值不進回傳（只出現在暫存檔裡）", async () => {
    const [jsonc] = opencodeConfigCandidates(home);
    await writeJsonFile(jsonc!, {
      plugins: [{ package: "<REPO_DIR>/packages/mnemoshelf-plugin", options: { token: SYNTHETIC_TOKEN } }],
      mcp: {
        servers: {
          mnemoshelf: {
            command: "synthetic",
            environment: { MNEMOSHELF_TOKEN: SYNTHETIC_TOKEN },
          },
        },
      },
    });
    await createRuntimeFile();

    const state = await readState();
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(SYNTHETIC_TOKEN);
    expect(serialized).not.toContain("MNEMOSHELF_TOKEN");
    expect(state.detection.opencode.matches.every((match) => !match.includes(SYNTHETIC_TOKEN))).toBe(true);
  });

  it("previews 與 buildCopyText 逐字相同（9 個 kind）", async () => {
    await createRuntimeFile();
    await createEntryFile();

    const state = await readState();
    const connection: AgentGuideConnection = {
      executablePath: process.execPath,
      entryPath,
      runtimeFile,
    };
    expect(sorted(Object.keys(state.previews))).toEqual(sorted(AGENT_GUIDE_COPY_KINDS));
    for (const kind of AGENT_GUIDE_COPY_KINDS) {
      expect(state.previews[kind]).toBe(buildCopyText(kind, connection));
    }
  });
});

describe("IPC 契約（靜態對照）", () => {
  it("desktop-api 的兩個新通道與 API 版本 3", () => {
    expect(DESKTOP_CHANNELS.agentGuideGetState).toBe("mnemoshelf:agent-guide:get-state");
    expect(DESKTOP_CHANNELS.agentGuideCopy).toBe("mnemoshelf:agent-guide:copy");
    expect(DESKTOP_API_VERSION).toBe(3);
    // 通道值不得重複（preload 用同一組字串）。
    expect(new Set(Object.values(DESKTOP_CHANNELS)).size).toBe(Object.values(DESKTOP_CHANNELS).length);
  });

  it("preload.cts 鏡像同一組通道、版本 3，且維持零 import", async () => {
    const source = await fs.readFile(new URL("../src/preload.cts", import.meta.url), "utf8");

    const mirrored = [...source.matchAll(/"(mnemoshelf:[^"]+)"/g)].map((match) => match[1]!);
    expect(new Set(mirrored)).toEqual(new Set(Object.values(DESKTOP_CHANNELS)));
    expect(source).toContain("const API_VERSION = 3;");
    expect(source).toContain("CHANNELS.agentGuideGetState");
    expect(source).toContain("CHANNELS.agentGuideCopy");
    // 參數是 unknown，非字串轉成空字串（main 再驗白名單）。
    expect(source).toContain('typeof kind === "string" ? kind : ""');
    // 零相依：只有 require("electron")，不得 import 型別。
    expect(source).not.toMatch(/^import /m);
    expect(source).toContain('require("electron")');
  });

  it("copyMcpConfig 與 agentGuide.copy 的回應形狀（三個鍵／兩個鍵）", () => {
    // 型別層由 typecheck 保證：少給或多給欄位都會編譯失敗。
    const mcpResponse: Awaited<ReturnType<DesktopBridge["settings"]["copyMcpConfig"]>> = {
      copied: false,
      url: null,
      reason: "appimage",
    };
    expect(Object.keys(mcpResponse)).toEqual(["copied", "url", "reason"]);

    const copyResult: DesktopAgentGuideCopyResult = { copied: false, reason: "clipboard-failed" };
    expect(Object.keys(copyResult)).toEqual(["copied", "reason"]);
  });

  it("main.ts 的舊按鈕改走 copyGate＋buildHarnessConfig，新 handler 走 buildCopyText", async () => {
    const source = await fs.readFile(new URL("../src/main.ts", import.meta.url), "utf8");

    // 不得再有第二份組裝或舊閘門。
    expect(source).not.toContain("buildMcpConfigSnippet");
    expect(source).not.toContain("canCopyMcpConfig");
    // 新 handler 與共用函式。
    expect(source).toContain("DESKTOP_CHANNELS.agentGuideGetState");
    expect(source).toContain("DESKTOP_CHANNELS.agentGuideCopy");
    expect(source).toContain("readAgentGuideState(");
    expect(source).toContain("buildCopyText(copyKind");
    expect(source).toContain('buildHarnessConfig("mcp-generic"');
    expect(source).toContain("copyGate({");
    // 舊按鈕的回應有三個鍵（copied／url／reason）。
    expect(source).toContain("{ copied: boolean; url: string | null; reason: AgentGuideBlockedReason | null }");
    expect(source).toContain("reason: decision.reason");
  });
});
