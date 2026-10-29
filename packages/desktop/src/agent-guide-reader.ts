/**
 * 「連接 Agent」頁的讀檔層：把卡 1（`agent-guide.ts`）的純函式接上真實檔案系統。
 *
 * 這裡只做三件事：
 * 1. 依卡 1 的路徑函式讀取 OpenCode／codex／dsh 的設定與外掛檔（`home`／`env` 全部由呼叫端注入，
 *    模組內不讀真實家目錄，因此可以在 vitest 用暫存目錄測）；
 * 2. 呼叫 `detectOpenCode`／`detectCodex`／`detectDsh` 取得三態與原因碼；
 * 3. 用 `copyGate` 算每個 kind 的阻擋原因，並用 `buildCopyText` 產生預覽（與複製逐字相同）。
 *
 * **回傳只有路徑、布林值與原因碼**：檔案內容、token、`environment` 的值都不會離開這個模組
 * （`detect*` 的 `matches` 只放位置字串）。
 *
 * 讀檔失敗**不丟錯**：偵測結果會是 `unknown` 並帶原因碼（卡 1 的優先序），
 * 讓 UI 顯示「無法判讀」而不是誤報「未安裝」。唯一例外是路徑本身不存在——
 * 那是正常情況（`file-missing`），不是錯誤。
 */
import { promises as fs, type Dirent, type Stats } from "node:fs";
import path from "node:path";
import {
  AGENT_GUIDE_COPY_KINDS,
  MAX_AGENT_GUIDE_CONFIG_BYTES,
  buildCopyText,
  codexConfigPaths,
  copyGate,
  detectCodex,
  detectDsh,
  detectOpenCode,
  dshProfilesDir,
  opencodeConfigCandidates,
  opencodePluginsDir,
  type AgentGuideBlockedReason,
  type AgentGuideConfigInput,
  type AgentGuideConnection,
  type AgentGuideCopyKind,
} from "./agent-guide.js";
import type { DesktopAgentGuideState } from "./desktop-api.js";

/**
 * `plugins/` 與 dsh profiles 的列舉上限。
 *
 * 這些目錄屬於使用者，可能有大量項目（或含怪東西）；超過上限的部分不讀，
 * 避免一次掃描拖慢設定頁，也避免把任意數量的檔案讀進記憶體。
 */
const MAX_LISTED_ENTRIES = 50;

/** 單一設定來源的讀取結果（別名沿用卡 1 的 `AgentGuideConfigInput["result"]`）。 */
type SourceResult = AgentGuideConfigInput["result"];

/** `readAgentGuideState` 的輸入（全部注入，測試不需要真實家目錄）。 */
export interface ReadAgentGuideStateInput {
  /** `os.homedir()`。 */
  home: string;
  /** 只取 `DSH_HOME` 這一個變數。 */
  env: { DSH_HOME?: string };
  /** `process.env.APPIMAGE`；AppImage 執行時有值。 */
  appImage: string | undefined;
  /** 連線資訊檔（`<userData>/data/runtime.json`）的真實路徑。 */
  runtimeFile: string;
  /** `resolveMcpEntryPath(...)` 的結果（MCP 入口腳本）。 */
  entryPath: string;
  /** 測試可固定時間；預設 `() => new Date()`。 */
  now?: () => Date;
}

/**
 * 讀單一設定來源：先 `stat`，再決定要不要讀。
 *
 * - `ENOENT`／不是一般檔案 → `file-missing`（正常情況，不是錯誤）；
 * - 其他 `stat` 錯誤（`EACCES`、`ENOTDIR`…）→ `read-error`；
 * - 超過 `MAX_AGENT_GUIDE_CONFIG_BYTES` → `too-large`，**不讀**；
 * - 讀檔失敗 → `read-error`。
 */
async function readSource(file: string): Promise<SourceResult> {
  let stats: Stats;
  try {
    stats = await fs.stat(file);
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "file-missing" : "read-error",
    };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: "file-missing" };
  }
  if (stats.size > MAX_AGENT_GUIDE_CONFIG_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  try {
    return { ok: true, text: await fs.readFile(file, "utf8") };
  } catch {
    return { ok: false, reason: "read-error" };
  }
}

/** 目錄列舉結果：`missing` 與 `read-error` 要分開，前者是常態、後者要讓偵測變 `unknown`。 */
type DirectoryListing =
  | { ok: true; entries: Dirent[] }
  | { ok: false; reason: "missing" | "read-error" };

async function listDirectory(dir: string): Promise<DirectoryListing> {
  try {
    return { ok: true, entries: await fs.readdir(dir, { withFileTypes: true }) };
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "read-error",
    };
  }
}

/** 依名稱排序（不依 locale：結果要跨平台可重現）。 */
function byName(a: Dirent, b: Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * OpenCode：兩個設定候選**全部**讀（設定是合併的，不能 first-hit-wins），
 * 加上 `plugins/` 底下每個項目的內容。
 */
async function readOpenCodeInputs(home: string): Promise<{
  configs: AgentGuideConfigInput[];
  pluginDirs: AgentGuideConfigInput[];
}> {
  const configs: AgentGuideConfigInput[] = [];
  for (const candidate of opencodeConfigCandidates(home)) {
    configs.push({ path: candidate, result: await readSource(candidate) });
  }

  const pluginDirs: AgentGuideConfigInput[] = [];
  const pluginsDir = opencodePluginsDir(home);
  const listed = await listDirectory(pluginsDir);
  if (!listed.ok) {
    // `plugins/` 不存在是常態（不傳任何輸入）；真正的列舉錯誤要傳一筆 read-error，
    // 讓偵測結果變 `unknown`——不能吞成「未安裝」。
    if (listed.reason === "read-error") {
      pluginDirs.push({ path: pluginsDir, result: { ok: false, reason: "read-error" } });
    }
    return { configs, pluginDirs };
  }

  for (const entry of listed.entries.slice().sort(byName).slice(0, MAX_LISTED_ENTRIES)) {
    const itemPath = path.join(pluginsDir, entry.name);
    if (entry.isDirectory()) {
      const manifestPath = path.join(itemPath, "package.json");
      const result = await readSource(manifestPath);
      // 沒有 package.json 的目錄照樣是候選：以空字串送出，讓「路徑本身含 mnemoshelf」
      // 或「目錄名是 opencode-plugin」的證據仍能被 detectOpenCode 採用。
      pluginDirs.push({
        path: itemPath,
        result: result.ok || result.reason !== "file-missing" ? result : { ok: true, text: "" },
      });
    } else {
      // 檔案項目直接讀它的內容（OpenCode 也接受單檔外掛）。
      pluginDirs.push({ path: itemPath, result: await readSource(itemPath) });
    }
  }
  return { configs, pluginDirs };
}

/** codex：`config.toml` 與 `hooks.json` 各一筆。 */
async function readCodexInputs(home: string): Promise<{
  config: AgentGuideConfigInput;
  hooks: AgentGuideConfigInput;
}> {
  const paths = codexConfigPaths(home);
  return {
    config: { path: paths.config, result: await readSource(paths.config) },
    hooks: { path: paths.hooks, result: await readSource(paths.hooks) },
  };
}

/**
 * dsh：profiles 目錄底下每個**子目錄**的 `package.json`（最多 50 個，名稱排序）。
 *
 * 根目錄不存在 → 空陣列；列舉失敗 → 一筆 `read-error`（名稱固定 `<profiles>`，
 * 不把路徑當 profile 名稱）。
 */
async function readDshProfiles(input: {
  home: string;
  env: { DSH_HOME?: string };
}): Promise<Array<{ name: string; packageJson: AgentGuideConfigInput }>> {
  const profilesDir = dshProfilesDir(input);
  const listed = await listDirectory(profilesDir);
  if (!listed.ok) {
    if (listed.reason === "missing") return [];
    return [
      {
        name: "<profiles>",
        packageJson: { path: profilesDir, result: { ok: false, reason: "read-error" } },
      },
    ];
  }

  const profiles: Array<{ name: string; packageJson: AgentGuideConfigInput }> = [];
  const directories = listed.entries
    .filter((entry) => entry.isDirectory())
    .sort(byName)
    .slice(0, MAX_LISTED_ENTRIES);
  for (const entry of directories) {
    const packageJsonPath = path.join(profilesDir, entry.name, "package.json");
    profiles.push({
      name: entry.name,
      packageJson: { path: packageJsonPath, result: await readSource(packageJsonPath) },
    });
  }
  return profiles;
}

/** 檔案是否存在且是一般檔案（閘門只認真的存在的檔案）。 */
async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * 讀取並彙整「連接 Agent」頁需要的狀態。
 *
 * `previews` 與之後 `agentGuide.copy` 用**同一個** `buildCopyText` 與同一組 `connection`：
 * 預覽與實際複製逐字相同，renderer 傳來的文字一律不採信。
 */
export async function readAgentGuideState(input: ReadAgentGuideStateInput): Promise<DesktopAgentGuideState> {
  const opencodeInputs = await readOpenCodeInputs(input.home);
  const codexInputs = await readCodexInputs(input.home);
  const dshProfiles = await readDshProfiles({ home: input.home, env: input.env });

  const runtimeFileExists = await fileExists(input.runtimeFile);
  const entryPathExists = await fileExists(input.entryPath);

  const connection: AgentGuideConnection = {
    // 複製與預覽都用 main process 自己的執行檔（片段另帶 ELECTRON_RUN_AS_NODE=1）。
    executablePath: process.execPath,
    entryPath: input.entryPath,
    runtimeFile: input.runtimeFile,
  };

  const blocked: Partial<Record<AgentGuideCopyKind, AgentGuideBlockedReason>> = {};
  // 迴圈走的是卡 1 的白名單，因此 `previews` 一定補滿全部 9 個 kind。
  const previews = {} as Record<AgentGuideCopyKind, string>;
  for (const kind of AGENT_GUIDE_COPY_KINDS) {
    const decision = copyGate({
      kind,
      appImage: input.appImage,
      runtimeFileExists,
      entryPathExists,
    });
    // 可以複製時**不出現在表裡**（不是存 null）。
    if (!decision.allowed && decision.reason !== null) {
      blocked[kind] = decision.reason;
    }
    previews[kind] = buildCopyText(kind, connection);
  }

  const now = input.now ?? (() => new Date());
  return {
    detectedAt: now().toISOString(),
    detection: {
      opencode: detectOpenCode(opencodeInputs),
      codex: detectCodex(codexInputs),
      dsh: detectDsh({ profiles: dshProfiles }),
    },
    runtimeFile: input.runtimeFile,
    entryPath: input.entryPath,
    copy: { blocked },
    previews,
  };
}
