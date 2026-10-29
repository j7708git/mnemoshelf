/**
 * 「連接 Agent」頁的純函式：設定片段、安裝卡與 harness 偵測。
 *
 * 這個模組只做資料進、字串出：
 * - **產生器**：`buildHarnessConfig`／`buildInstallCard`／`buildCopyText`，輸出給使用者貼上的
 *   設定片段與給 agent 讀的安裝卡。
 * - **解析器**：`detectOpenCode`／`detectCodex`／`detectDsh`，輸入是呼叫端讀到的文字，
 *   回傳三態（`detected`／`not-detected`／`unknown`）與穩定原因碼。
 * - **路徑**：`opencodeConfigCandidates` 等純函式，供讀檔層使用（本模組不讀檔）。
 * - **閘門**：`copyGate`，複製前檢查 runtime.json／MCP 入口／AppImage。
 *
 * **不含 token**：片段只帶 `MNEMOSHELF_RUNTIME_FILE`（路徑）、`MNEMOSHELF_PROJECT` 與
 * `ELECTRON_RUN_AS_NODE`；token 由 MCP 入口在執行時自行從 runtime.json 讀取。
 * 偵測結果只回外掛 package 路徑／profile 名稱與布林值，**不回** `plugins[].options` 或
 * `mcp.servers.*.environment` 的內容——token 會藏在那些地方。
 *
 * 為什麼外掛目錄用字面 `<REPO_DIR>`：App 不知道使用者把 repo clone 到哪裡，
 * 也不該猜；使用者自己把 placeholder 換成實際路徑。
 *
 * **JSONC 與 TOML 都不引入依賴**：JSONC 由本檔的字串狀態掃描器處理；codex 的
 * `config.toml` 只做表頭掃描（見 `detectCodex` 的註解），不是完整的 TOML 解析器。
 */
import path from "node:path";

// ---- 共用常數 ----

/**
 * 設定片段預設的專案名稱（`MNEMOSHELF_PROJECT`）。
 *
 * 這是最容易與文件漂移的值：`docs/agent-integration.md` 的範例與設定頁文案是**人工同步**的，
 * 不會在測試裡自動對照（文件不是程式）。改這裡時請一併檢查那兩處；片段本身與測試則直接引用
 * 這個常數。使用者可在自己的 MCP 設定檔改成別的專案名稱。
 */
export const DEFAULT_MCP_PROJECT = "mnemoshelf";

/**
 * 讓 Electron 執行檔以一般 Node.js 身分啟動的環境變數。
 *
 * 片段一定要帶這個（值 `"1"`），否則 MCP client 啟動的是第二個桌面應用程式實例，
 * 不是 stdio 的 MCP 入口。
 */
export const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

/**
 * 設定檔讀取上限（1 MiB）。讀檔層（IPC／main）先 stat，超過就當 `too-large`，
 * 不把整個檔案讀進記憶體。
 */
export const MAX_AGENT_GUIDE_CONFIG_BYTES = 1024 * 1024;

/**
 * 打包版 MCP 入口在 `app.asar.unpacked` 下的相對路徑。
 *
 * 為什麼會在 unpacked：electron-builder 的 `asarUnpack: "**\/node_modules/**"`
 * 把所有 production 相依解包到 asar 之外（原生模組需要真實檔案；MCP 入口也要能
 * 被一般 `node` 執行，asar 內的虛擬檔案系統一般 node 讀不到）。
 */
export const PACKAGED_MCP_ENTRY_SEGMENTS = [
  "app.asar.unpacked",
  "node_modules",
  "@mnemoshelf",
  "server",
  "dist",
  "scripts",
  "mcp.js",
] as const;

/** 外掛目錄與 dsh 套件的字面 placeholder；不得換成 App 猜的 clone 路徑。 */
const REPO_DIR_PLACEHOLDER = "<REPO_DIR>";
/** 設定片段裡的 server 名稱（與 `DEFAULT_MCP_PROJECT` 同值，但語意不同）。 */
const SERVER_NAME = "mnemoshelf";

// ---- 偵測：型別 ----

/** 支援偵測的 harness。 */
export type AgentGuideHarness = "opencode" | "codex" | "dsh";

/** 三態：偵測到／未偵測到／無法判讀（讀不到、太大或格式壞都算無法判讀）。 */
export type AgentGuideDetectState = "detected" | "not-detected" | "unknown";

/** 穩定的偵測原因碼；`unsupported` 保留給未來 harness，目前不會回傳。 */
export type AgentGuideDetectReason =
  | "ok"
  | "file-missing"
  | "not-configured"
  | "read-error"
  | "too-large"
  | "invalid-format"
  | "unsupported";

/** 呼叫端讀到的單一設定來源。 */
export interface AgentGuideConfigInput {
  /** 顯示用路徑（呼叫端用 path.join 產生；測試用 placeholder）。 */
  path: string;
  /**
   * 讀取結果。`ok: false` 由呼叫端在 stat／讀檔失敗時給；
   * `"file-missing"` 代表「這個來源不存在」——那是正常情況，**不是**錯誤。
   */
  result:
    | { ok: true; text: string }
    | { ok: false; reason: "file-missing" | "read-error" | "too-large" };
}

/** 單一 harness 的偵測結果。 */
export interface AgentGuideHarnessDetection {
  state: AgentGuideDetectState;
  reason: AgentGuideDetectReason;
  /**
   * 命中的識別字，已去重＋排序：
   * - opencode：外掛 package 路徑（設定檔或 plugins/ 目錄）
   * - dsh：命中的 profile 名稱
   * - codex：一律 []
   * **不得**放 options／environment 的任何內容。
   */
  matches: string[];
  /** 是否已設定 mnemoshelf 的 MCP server。 */
  mcpConfigured: boolean;
  /** codex 專用：hooks.json 是否已有 mnemoshelf hook；其他 harness 一律 false。 */
  hookConfigured: boolean;
  /** 這次實際讀了幾個來源（包含不存在與失敗的）。 */
  sourcesChecked: number;
}

// ---- 偵測：內部工具 ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 不分大小寫的 `mnemoshelf` 比對（路徑、package 名、command 內容共用）。 */
function mentionsMnemoshelf(value: string): boolean {
  return value.toLowerCase().includes("mnemoshelf");
}

/**
 * JSONC → 值。只處理本專案需要的寬容語法：BOM、行／塊註解、尾逗號。
 *
 * 註解**只在字串外**生效：字串內的 `//`（例如 `https://opencode.ai/config.json`）、
 * `/*`／`*\/` 與轉義字元（`\"`、`\\`、`\uXXXX`）都原樣保留。
 * 只有註解（去掉後沒有值）→ 丟出錯誤，由上層映射成 `invalid-format`。
 */
function parseJsonc(text: string): unknown {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const withoutComments = stripJsonComments(withoutBom);
  const cleaned = stripTrailingCommas(withoutComments);
  if (cleaned.trim() === "") {
    throw new Error("JSONC 內容為空（只有註解或空白）");
  }
  return JSON.parse(cleaned);
}

/** 移除 JSONC 的行註解與塊註解；字串內容（含轉義）一律原樣複製。 */
function stripJsonComments(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const end = findStringEnd(text, index);
      output += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) {
        throw new Error("塊註解沒有結尾");
      }
      index = end + 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

/** 回傳字串的結束位置（不含）；跳過被反斜線轉義的字元。 */
function findStringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    index += 1;
    if (char === '"') {
      return index;
    }
  }
  throw new Error("字串沒有結尾");
}

/** 移除 `}`／`]` 前的尾逗號；字串內容不受影響。 */
function stripTrailingCommas(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const end = findStringEnd(text, index);
      output += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead]!)) {
        lookahead += 1;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        index += 1;
        continue;
      }
    }
    output += char;
    index += 1;
  }
  return output;
}

/** JSON（非 JSONC）→ 物件；BOM 先吃掉，非物件視為格式錯誤。 */
function parseJsonObjectStrict(text: string): Record<string, unknown> {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const value: unknown = JSON.parse(withoutBom);
  if (!isRecord(value)) {
    throw new Error("最外層不是物件");
  }
  return value;
}

/** JSONC → 物件；非物件視為格式錯誤。 */
function parseJsoncObject(text: string): Record<string, unknown> {
  const value = parseJsonc(text);
  if (!isRecord(value)) {
    throw new Error("最外層不是物件");
  }
  return value;
}

/** 從 OpenCode 設定的 `plugins` 值取出候選字串（三種形狀都吃）。 */
function collectPluginCandidates(plugins: unknown): string[] {
  const candidates: string[] = [];
  if (Array.isArray(plugins)) {
    for (const entry of plugins) {
      if (typeof entry === "string") {
        candidates.push(entry);
      } else if (isRecord(entry) && typeof entry.package === "string") {
        candidates.push(entry.package);
      }
    }
    return candidates;
  }
  if (isRecord(plugins)) {
    // 物件表：鍵與值裡的 `package` 都當候選字串。
    // 註：OpenCode 物件表的正式語意未經原始碼確認，這裡刻意只做寬鬆的字串掃描，
    // 不對「鍵代表什麼」做語意推論（見任務卡 §4 的未知項）。
    for (const [key, value] of Object.entries(plugins)) {
      candidates.push(key);
      if (isRecord(value) && typeof value.package === "string") {
        candidates.push(value.package);
      }
    }
  }
  return candidates;
}

/** 單一候選字串是否命中（路徑含 mnemoshelf，或最後一段等於 opencode-plugin）。 */
function candidatePathMatches(candidate: string): boolean {
  return mentionsMnemoshelf(candidate) || path.basename(candidate) === "opencode-plugin";
}

/** 從 OpenCode 設定判斷是否已設定 mnemoshelf 的 MCP server。只看位置欄位。 */
function openCodeMcpConfigured(config: Record<string, unknown>): boolean {
  const mcp = isRecord(config.mcp) ? config.mcp : undefined;
  const servers = mcp !== undefined && isRecord(mcp.servers) ? mcp.servers : undefined;
  if (servers === undefined) {
    return false;
  }
  for (const [name, value] of Object.entries(servers)) {
    if (mentionsMnemoshelf(name)) {
      return true;
    }
    if (!isRecord(value)) {
      continue;
    }
    const { command, args } = value;
    if (typeof command === "string" && mentionsMnemoshelf(command)) {
      return true;
    }
    if (Array.isArray(command) && command.some((item) => typeof item === "string" && mentionsMnemoshelf(item))) {
      return true;
    }
    if (Array.isArray(args) && args.some((item) => typeof item === "string" && mentionsMnemoshelf(item))) {
      return true;
    }
  }
  return false;
}

/** 依 F 表把「有無命中、失敗、格式、存在」收斂成三態。 */
function summarizeDetection(input: {
  matches: string[];
  hardFailure: "read-error" | "too-large" | null;
  invalidFormat: boolean;
  anySourceExists: boolean;
  sourcesChecked: number;
}): AgentGuideHarnessDetection {
  const matches = [...new Set(input.matches)].sort();
  if (matches.length > 0) {
    return {
      state: "detected",
      reason: "ok",
      matches,
      mcpConfigured: false,
      hookConfigured: false,
      sourcesChecked: input.sourcesChecked,
    };
  }
  if (input.hardFailure !== null) {
    return {
      state: "unknown",
      reason: input.hardFailure,
      matches: [],
      mcpConfigured: false,
      hookConfigured: false,
      sourcesChecked: input.sourcesChecked,
    };
  }
  if (input.invalidFormat) {
    return {
      state: "unknown",
      reason: "invalid-format",
      matches: [],
      mcpConfigured: false,
      hookConfigured: false,
      sourcesChecked: input.sourcesChecked,
    };
  }
  return {
    state: "not-detected",
    reason: input.anySourceExists ? "not-configured" : "file-missing",
    matches: [],
    mcpConfigured: false,
    hookConfigured: false,
    sourcesChecked: input.sourcesChecked,
  };
}

/** 共用的來源狀態收集器（保留輸入順序中第一個硬失敗）。 */
interface SourceScanState {
  hardFailure: "read-error" | "too-large" | null;
  anySourceExists: boolean;
  invalidFormat: boolean;
  sourcesChecked: number;
}

function createScanState(): SourceScanState {
  return { hardFailure: null, anySourceExists: false, invalidFormat: false, sourcesChecked: 0 };
}

/** 登記一個來源；回傳它是否可讀（`ok: true`）。 */
function registerSource(state: SourceScanState, source: AgentGuideConfigInput): boolean {
  state.sourcesChecked += 1;
  if (source.result.ok) {
    state.anySourceExists = true;
    return true;
  }
  if (source.result.reason === "file-missing") {
    return false;
  }
  if (state.hardFailure === null) {
    state.hardFailure = source.result.reason;
  }
  return false;
}

// ---- 偵測：對外函式 ----

/**
 * OpenCode／OpenChamber：掃描**所有**設定候選與 plugins/ 目錄。
 *
 * OpenCode 的設定是合併的，不能 first-hit-wins：任何一個來源命中就算偵測到，
 * 即使其他來源讀不到。命中條件三選一（見任務卡 §6.2）：
 * 該候選對應的 package.json `name` 含 `mnemoshelf`、候選路徑含 `mnemoshelf`、
 * 或候選路徑最後一段等於 `opencode-plugin`。
 */
export function detectOpenCode(input: {
  configs: AgentGuideConfigInput[];
  pluginDirs: AgentGuideConfigInput[];
}): AgentGuideHarnessDetection {
  const state = createScanState();
  const candidates: Array<{ value: string; packageName?: string }> = [];
  const matches: string[] = [];
  let mcpConfigured = false;

  for (const config of input.configs) {
    if (!registerSource(state, config)) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsoncObject(config.result.ok ? config.result.text : "");
    } catch {
      state.invalidFormat = true;
      continue;
    }
    if (openCodeMcpConfigured(parsed)) {
      mcpConfigured = true;
    }
    for (const candidate of collectPluginCandidates(parsed.plugins)) {
      candidates.push({ value: candidate });
    }
  }

  for (const pluginDir of input.pluginDirs) {
    if (!registerSource(state, pluginDir)) {
      continue;
    }
    let packageName: string | undefined;
    const text = pluginDir.result.ok ? pluginDir.result.text : "";
    if (text.trim() !== "") {
      try {
        const manifest = parseJsoncObject(text);
        if (typeof manifest.name === "string") {
          packageName = manifest.name;
        }
      } catch {
        // package.json 壞掉 → 這個來源算解析失敗；但目錄路徑本身仍是候選字串，
        // 路徑的正面證據（含 mnemoshelf／最後一段 opencode-plugin）不能被吃掉。
        state.invalidFormat = true;
      }
    }
    candidates.push({ value: pluginDir.path, ...(packageName === undefined ? {} : { packageName }) });
  }

  for (const candidate of candidates) {
    const hit =
      (candidate.packageName !== undefined && mentionsMnemoshelf(candidate.packageName)) ||
      candidatePathMatches(candidate.value);
    if (hit) {
      matches.push(candidate.value);
    }
  }

  const summary = summarizeDetection({
    matches,
    hardFailure: state.hardFailure,
    invalidFormat: state.invalidFormat,
    anySourceExists: state.anySourceExists,
    sourcesChecked: state.sourcesChecked,
  });
  // MCP 已設定也是正面證據：只設 MCP、沒裝外掛時不能顯示成「未偵測到」。
  const detected = matches.length > 0 || mcpConfigured;
  return {
    ...summary,
    state: detected ? "detected" : summary.state,
    reason: detected ? "ok" : summary.reason,
    mcpConfigured,
    hookConfigured: false,
  };
}

/**
 * 移除 TOML 一行的尾端註解。`#` 只在**字串外**才算註解：
 * basic string（`"…"`，`\"` 會跳過）與 literal string（`'…'`）內的 `#` 原樣保留。
 */
function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (quote === '"') {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "#") {
      return line.slice(0, index);
    }
    index += 1;
  }
  return line;
}

/** 這一行在字串外的 `[`／`]` 淨增量（用來判斷是否還在一段多行陣列裡；字串內的括號不計）。 */
function bracketDeltaOutsideStrings(line: string): number {
  let quote: '"' | "'" | null = null;
  let delta = 0;
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (quote === '"') {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "[") {
      delta += 1;
    } else if (char === "]") {
      delta -= 1;
    }
    index += 1;
  }
  return delta;
}

/**
 * codex：`config.toml` 只做**逐行表頭掃描**（不引入 TOML 依賴）。
 *
 * 規則（本卡對「格式壞不可降級」的唯一 TOML 驗證）：
 * - 先移除**字串外**的 `#` 尾端註解（支援 `"…"` 與 `'…'`），再比對；
 * - 忽略空行；
 * - 值行若開啟多行陣列（`key = [`），在括號收合前一律不當表頭——多行陣列的元素即使以
 *   `[` 開頭（例如 `  [1, 2],`）也不會被誤判成表頭；**陣列到檔尾仍未收合 → `invalid-format`**
 *   （不可默默忽略後面的表頭，把壞檔說成「未設定」）；
 * - 其餘 `trim()` 後以 `[` 開頭的行必須是 `[表頭]` 或 `[[表頭]]`，否則整份檔案判
 *   `invalid-format`（缺 `]` 的壞表頭**不得**降級成「未偵測到」）；
 * - `[mcp_servers.mnemoshelf]` 或其子表頭（例如 `[mcp_servers.mnemoshelf.env]`）→ 已設定 MCP。
 *
 * 這不是完整 TOML 解析：其他語法錯誤（重複鍵、壞值）不偵測，這是刻意的取捨，
 * 避免為了一個布林值引入 TOML 套件。
 */
function scanCodexConfig(text: string): boolean {
  let configured = false;
  /** >0 表示目前在一段多行陣列裡（那是值，不是表頭）。 */
  let arrayDepth = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") {
      continue;
    }
    if (arrayDepth > 0) {
      arrayDepth = Math.max(0, arrayDepth + bracketDeltaOutsideStrings(line));
      continue;
    }
    if (!line.startsWith("[")) {
      // 值行可能開啟多行陣列：`args = [`。
      arrayDepth = Math.max(0, bracketDeltaOutsideStrings(line));
      continue;
    }
    const isTable = /^\[\[[^\[\]]+\]\]$/.test(line) || /^\[[^\[\]]+\]$/.test(line);
    if (!isTable) {
      throw new Error("TOML 表頭括號不匹配");
    }
    const inner = line.startsWith("[[") ? line.slice(2, -2) : line.slice(1, -1);
    const parts = inner.split(".").map((part) => part.trim());
    if (parts[0] === "mcp_servers" && parts[1] === SERVER_NAME) {
      configured = true;
    }
  }
  if (arrayDepth > 0) {
    // 多行陣列沒有收合：整份檔案是壞的。不能默默忽略後面的表頭（那會把壞檔說成「未設定」）。
    throw new Error("TOML 陣列沒有收合");
  }
  return configured;
}

/** 遞迴找任何字串欄位含 `mnemoshelf`（只看值，不看鍵）。 */
function containsMnemoshelfString(value: unknown): boolean {
  if (typeof value === "string") {
    return mentionsMnemoshelf(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsMnemoshelfString(item));
  }
  if (isRecord(value)) {
    return Object.values(value).some((item) => containsMnemoshelfString(item));
  }
  return false;
}

/**
 * codex：`config.toml` 有 `[mcp_servers.mnemoshelf]` 或 `hooks.json` 有含 `mnemoshelf`
 * 的字串（例如 `command` 指向 `recall.mjs`）就算偵測到。`matches` 一律 `[]`。
 */
export function detectCodex(input: {
  config: AgentGuideConfigInput;
  hooks: AgentGuideConfigInput;
}): AgentGuideHarnessDetection {
  const state = createScanState();
  let mcpConfigured = false;
  let hookConfigured = false;

  if (registerSource(state, input.config) && input.config.result.ok) {
    try {
      mcpConfigured = scanCodexConfig(input.config.result.text);
    } catch {
      state.invalidFormat = true;
    }
  }

  if (registerSource(state, input.hooks) && input.hooks.result.ok) {
    try {
      hookConfigured = containsMnemoshelfString(parseJsonObjectStrict(input.hooks.result.text));
    } catch {
      state.invalidFormat = true;
    }
  }

  const summary = summarizeDetection({
    matches: [],
    hardFailure: state.hardFailure,
    invalidFormat: state.invalidFormat,
    anySourceExists: state.anySourceExists,
    sourcesChecked: state.sourcesChecked,
  });
  const detected = mcpConfigured || hookConfigured;
  return {
    ...summary,
    state: detected ? "detected" : summary.state,
    reason: detected ? "ok" : summary.reason,
    mcpConfigured,
    hookConfigured,
  };
}

/**
 * dsh：逐一解析 profile 的 `package.json`。
 *
 * 命中若 `dependencies`／`devDependencies` 有任何鍵含 `mnemoshelf`，或
 * `dsh.profile.bundles` 任一元素含 `mnemoshelf`。命中時 `matches` 放 profile 名稱。
 */
export function detectDsh(input: {
  profiles: Array<{ name: string; packageJson: AgentGuideConfigInput }>;
}): AgentGuideHarnessDetection {
  const state = createScanState();
  const matches: string[] = [];

  for (const profile of input.profiles) {
    if (!registerSource(state, profile.packageJson)) {
      continue;
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = parseJsonObjectStrict(profile.packageJson.result.ok ? profile.packageJson.result.text : "");
    } catch {
      state.invalidFormat = true;
      continue;
    }
    if (dshProfileMatches(manifest)) {
      matches.push(profile.name);
    }
  }

  return summarizeDetection({
    matches,
    hardFailure: state.hardFailure,
    invalidFormat: state.invalidFormat,
    anySourceExists: state.anySourceExists,
    sourcesChecked: state.sourcesChecked,
  });
}

/** dsh profile 是否已含 mnemoshelf（dependencies／devDependencies／bundles）。 */
function dshProfileMatches(manifest: Record<string, unknown>): boolean {
  for (const field of ["dependencies", "devDependencies"] as const) {
    const dependencies = manifest[field];
    if (isRecord(dependencies) && Object.keys(dependencies).some((name) => mentionsMnemoshelf(name))) {
      return true;
    }
  }
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : undefined;
  const profile = dsh !== undefined && isRecord(dsh.profile) ? dsh.profile : undefined;
  const bundles = profile?.bundles;
  return Array.isArray(bundles) && bundles.some((item) => typeof item === "string" && mentionsMnemoshelf(item));
}

// ---- 路徑（純函式，供讀檔層使用） ----

/**
 * OpenCode 使用者層設定候選（**三個平台都一樣**，含 Windows：
 * `%USERPROFILE%\.config\opencode\`）。先 `.jsonc` 再 `.json`，兩個都要讀（設定是合併的）。
 */
export function opencodeConfigCandidates(home: string): string[] {
  return [
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(home, ".config", "opencode", "opencode.json"),
  ];
}

/** OpenCode 使用者層外掛目錄（不是專案層 `.opencode/`）。 */
export function opencodePluginsDir(home: string): string {
  return path.join(home, ".config", "opencode", "plugins");
}

/** codex 的設定檔與 hooks 檔。 */
export function codexConfigPaths(home: string): { config: string; hooks: string } {
  return {
    config: path.join(home, ".codex", "config.toml"),
    hooks: path.join(home, ".codex", "hooks.json"),
  };
}

/** dsh profiles 目錄；`DSH_HOME` 非空時用 `$DSH_HOME/profiles`。 */
export function dshProfilesDir(input: { home: string; env: { DSH_HOME?: string } }): string {
  const override = input.env.DSH_HOME?.trim();
  if (override !== undefined && override !== "") {
    return path.join(override, "profiles");
  }
  return path.join(input.home, ".dsh", "profiles");
}

// ---- MCP 入口路徑與既有片段（行為與 `mcp-entry.ts` 搬遷前一致） ----

/**
 * 解析 MCP 入口的可執行檔路徑。
 *
 * - 打包版：`<resourcesPath>/app.asar.unpacked/node_modules/@mnemoshelf/server/dist/scripts/mcp.js`
 * - 開發模式：`<repo>/packages/server/dist/scripts/mcp.js`
 *   （`app.getAppPath()` 是 `packages/desktop`，同層的 `packages/server` 就是來源）
 */
export function resolveMcpEntryPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  if (input.isPackaged) {
    return path.join(input.resourcesPath, ...PACKAGED_MCP_ENTRY_SEGMENTS);
  }
  return path.resolve(input.appPath, "..", "server", "dist", "scripts", "mcp.js");
}

/**
 * 產生可直接貼進 MCP client 的通用設定片段（JSON，`mcpServers` 形狀）。
 *
 * 只帶三個環境變數：
 * - `MNEMOSHELF_RUNTIME_FILE`：入口據此找到連線資訊檔並自行讀取網址與 token；
 * - `MNEMOSHELF_PROJECT`：`remember` 的預設專案名稱（預設 `DEFAULT_MCP_PROJECT`）；
 * - `ELECTRON_RUN_AS_NODE=1`：讓 Electron 執行檔以 Node.js 身分執行入口腳本。
 *
 * **不帶 token、也不帶網址**——這是刻意的，避免全權憑證經過剪貼簿與第三方設定檔；
 * 網址由入口在執行時從 `runtime.json` 讀取（服務每次啟動可能換埠）。
 *
 * `executablePath` 由呼叫端傳入（正式路徑是 `process.execPath`）。刻意不在函式內直接讀
 * `process.execPath`：這樣才能在不啟動 Electron 的情況下單元測試輸出。
 */
export function buildMcpConfigSnippet(input: {
  /** MCP 入口的路徑（`resolveMcpEntryPath` 的結果）。 */
  entryPath: string;
  /** 連線資訊檔的路徑（`runtime.json`）。 */
  runtimeFile: string;
  /**
   * 桌面版自己的執行檔（正式呼叫端傳 `process.execPath`）。
   * 打包後是 `<App>.app/Contents/MacOS/<名稱>`（macOS）或安裝目錄下的應用程式執行檔。
   */
  executablePath: string;
  /** 預設專案名稱；空白視為未指定，退回 `DEFAULT_MCP_PROJECT`。 */
  project?: string;
  /** MCP server 名稱；預設 `mnemoshelf`。 */
  serverName?: string;
}): string {
  const name = input.serverName ?? SERVER_NAME;
  const requestedProject = input.project?.trim();
  const project = requestedProject === undefined || requestedProject === "" ? DEFAULT_MCP_PROJECT : requestedProject;
  return JSON.stringify(
    {
      mcpServers: {
        [name]: {
          type: "stdio",
          command: input.executablePath,
          args: [input.entryPath],
          env: {
            MNEMOSHELF_RUNTIME_FILE: input.runtimeFile,
            MNEMOSHELF_PROJECT: project,
            [ELECTRON_RUN_AS_NODE]: "1",
          },
        },
      },
    },
    null,
    2,
  );
}

/** 不複製 MCP 設定片段的原因（穩定字串；IPC 只回 `copied: false`，原因寫 stderr）。 */
export type McpConfigCopyBlockedReason = "appimage" | "runtime-missing" | "entry-missing";

/** `canCopyMcpConfig` 的判斷結果。 */
export interface McpConfigCopyDecision {
  /** 是否可以複製片段。 */
  allowed: boolean;
  /** 不能複製時的原因；可以時為 `null`。 */
  reason: McpConfigCopyBlockedReason | null;
  /** 給 stderr／使用者看的說明（不含路徑、不含 token）；可以時為 `null`。 */
  message: string | null;
}

/**
 * 舊版「複製 MCP 設定片段」的存在性與環境檢查（純函式；檔案系統的檢查由呼叫端做完再傳進來）。
 *
 * 三種情況不給片段：
 * - **Linux AppImage**（`process.env.APPIMAGE` 有值）：執行檔路徑每次啟動都不同，
 *   app 結束後掛載點就消失，貼進去的片段下一次必然失效；建議改用環境變數連線。
 * - **連線資訊檔不存在**：入口啟動時會找不到憑證（`runtime-missing`）。
 * - **入口腳本不存在**：建置不完整時片段只會讓 client 啟動失敗（`entry-missing`）。
 *
 * 為什麼要抽成純函式：`main.ts` 的 IPC handler 難以在單元測試裡直接呼叫；這裡只做決策，
 * 測試傳入布林值即可，不需要真的開檔。
 */
export function canCopyMcpConfig(input: {
  /** `process.env.APPIMAGE`；AppImage 執行時有值。 */
  appImage: string | undefined;
  /** 連線資訊檔是否已存在且是一般檔案。 */
  runtimeFileExists: boolean;
  /** MCP 入口腳本是否存在且是一般檔案。 */
  entryPathExists: boolean;
}): McpConfigCopyDecision {
  if (input.appImage !== undefined && input.appImage.trim() !== "") {
    return {
      allowed: false,
      reason: "appimage",
      message:
        "AppImage 的執行檔路徑每次啟動都不同、結束後掛載點就消失，因此不提供可直接貼用的片段；" +
        "請改用環境變數 MNEMOSHELF_URL 與 MNEMOSHELF_TOKEN 連線（或使用解壓後的版本）。",
    };
  }
  if (!input.runtimeFileExists) {
    return {
      allowed: false,
      reason: "runtime-missing",
      message: "連線資訊檔尚未寫出；請在設定頁開啟「Agent 連線資訊」並重新啟動應用程式。",
    };
  }
  if (!input.entryPathExists) {
    return {
      allowed: false,
      reason: "entry-missing",
      message:
        "找不到 MCP 入口腳本（這個建置可能不完整）；請改用環境變數 MNEMOSHELF_URL 與 MNEMOSHELF_TOKEN 連線。",
    };
  }
  return { allowed: true, reason: null, message: null };
}

// ---- 片段與安裝卡 ----

/** 可產生的設定片段種類。 */
export type AgentGuideConfigKind =
  | "opencode-plugins"
  | "opencode-mcp"
  | "mcp-generic"
  | "codex-mcp"
  | "dsh-profile";

/** 頁面上的四個 tab。 */
export type AgentGuideHarnessTab = "opencode" | "codex" | "dsh" | "other";

/** 可複製的內容種類（五種片段＋四張安裝卡）。 */
export type AgentGuideCopyKind =
  | "opencode-plugins"
  | "opencode-mcp"
  | "mcp-generic"
  | "codex-mcp"
  | "dsh-profile"
  | "install-card-opencode"
  | "install-card-codex"
  | "install-card-dsh"
  | "install-card-generic";

/** 產生片段與安裝卡需要的連線資訊（**沒有 token 欄位**）。 */
export interface AgentGuideConnection {
  /** `process.execPath`（桌面版自己的執行檔）。 */
  executablePath: string;
  /** `resolveMcpEntryPath` 的結果。 */
  entryPath: string;
  /** `runtime.json` 的真實路徑。 */
  runtimeFile: string;
  /** 空白視為未指定 → `DEFAULT_MCP_PROJECT`。 */
  project?: string;
  /** 只 `dsh-profile`／`install-card-dsh` 用；未給時用 `<PROFILE>`。 */
  dshProfile?: string;
}

/** 空白視為未指定，退回預設專案名。 */
function resolveProject(project: string | undefined): string {
  const trimmed = project?.trim();
  return trimmed === undefined || trimmed === "" ? DEFAULT_MCP_PROJECT : trimmed;
}

/** TOML basic string 的跳脫（`\`、`"`、換行、tab、回車）。 */
function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

/**
 * 產生五種設定片段。JSON 片段是合法 JSON（可直接 `JSON.parse`）；
 * `codex-mcp` 是 TOML 片段（不是 JSON）。
 *
 * 所有片段都不含 token、不含真實 clone 路徑：外掛與 dsh 的目錄一律用字面 `<REPO_DIR>`。
 */
export function buildHarnessConfig(kind: AgentGuideConfigKind, input: AgentGuideConnection): string {
  const project = resolveProject(input.project);
  switch (kind) {
    case "opencode-plugins":
      return JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugins: [{ package: `${REPO_DIR_PLACEHOLDER}/packages/opencode-plugin` }],
        },
        null,
        2,
      );
    case "opencode-mcp":
      return JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            servers: {
              [SERVER_NAME]: {
                type: "local",
                command: [input.executablePath, input.entryPath],
                environment: {
                  MNEMOSHELF_RUNTIME_FILE: input.runtimeFile,
                  MNEMOSHELF_PROJECT: project,
                  [ELECTRON_RUN_AS_NODE]: "1",
                },
              },
            },
          },
        },
        null,
        2,
      );
    case "mcp-generic":
      return buildMcpConfigSnippet({
        entryPath: input.entryPath,
        runtimeFile: input.runtimeFile,
        executablePath: input.executablePath,
        project,
      });
    case "codex-mcp":
      return [
        `[mcp_servers.${SERVER_NAME}]`,
        `command = "${escapeTomlBasicString(input.executablePath)}"`,
        `args = ["${escapeTomlBasicString(input.entryPath)}"]`,
        `env = { MNEMOSHELF_RUNTIME_FILE = "${escapeTomlBasicString(input.runtimeFile)}", ` +
          `MNEMOSHELF_PROJECT = "${escapeTomlBasicString(project)}", ${ELECTRON_RUN_AS_NODE} = "1" }`,
      ].join("\n");
    case "dsh-profile":
      return JSON.stringify(
        {
          dependencies: {
            "@mnemoshelf/dsh-plugin": `link:${REPO_DIR_PLACEHOLDER}/packages/dsh-plugin`,
          },
          dsh: {
            profile: {
              bundles: ["@mnemoshelf/dsh-plugin"],
            },
          },
        },
        null,
        2,
      );
    default:
      throw new Error(`未知的設定片段種類：${String(kind)}`);
  }
}

/** dsh 安裝卡用的 profile 名稱（未指定時是字面 placeholder）。 */
function resolveDshProfile(profile: string | undefined): string {
  const trimmed = profile?.trim();
  return trimmed === undefined || trimmed === "" ? "<PROFILE>" : trimmed;
}

/** 所有安裝卡共用的第 1 步：確認 runtime.json 存在。 */
function runtimeStep(input: AgentGuideConnection): string[] {
  return [
    "## 1. 確認連線資訊檔存在",
    "",
    "請使用者打開 Mnemoshelf 的「設定 → Agent 連線資訊」開關，然後**重新啟動 App**，",
    "確認這個檔案存在（權限 0600；明確指定的路徑不會退回平台預設值）：",
    "",
    "```text",
    input.runtimeFile,
    "```",
    "",
  ];
}

/**
 * 產生給 agent 讀的安裝卡（Markdown）。
 *
 * 每張卡的內嵌片段都呼叫 `buildHarnessConfig`，**不得**自己另組一份字串：
 * 卡片與按鈕複製的片段才會永遠一致。
 */
export function buildInstallCard(harness: AgentGuideHarnessTab, input: AgentGuideConnection): string {
  const project = resolveProject(input.project);
  const lines: string[] = [];
  switch (harness) {
    case "opencode": {
      const snippet = buildHarnessConfig("opencode-plugins", input);
      lines.push(
        "# 把 Mnemoshelf 接到 OpenCode／OpenChamber（給 agent 的安裝卡）",
        "",
        "你是協助使用者安裝 Mnemoshelf 的 agent。照下面做完，OpenCode 會在**第一輪**與**訊息含明示線索**時自動召回記憶（預設 `trigger: first-turn+explicit`，見文件 §6.1）；`/memory` 會顯示「已連線」。",
        "",
        ...runtimeStep(input),
        "## 2. 取得並建置外掛",
        "",
        "在放 repo 的目錄（下面用 `<REPO_DIR>` 代表實際 clone 路徑）：",
        "",
        "```sh",
        "git clone <MNEMOSHELF_REPO_URL> mnemoshelf",
        "cd mnemoshelf",
        "pnpm install",
        "pnpm --filter @mnemoshelf/opencode-plugin build",
        "```",
        "",
        "## 3. 把外掛加進 OpenCode 設定",
        "",
        "把下面片段併進 `~/.config/opencode/opencode.jsonc` 的 `plugins`（不要覆蓋其他設定）：",
        "",
        "```json",
        snippet,
        "```",
        "",
        "- 把 `<REPO_DIR>` 換成實際 clone 路徑（`package` 必須是目錄，不是 `dist/index.js`）。",
        "- Windows 也是 `~/.config/opencode/`，**不是** `%APPDATA%`。",
        "- 路徑建議用正斜線；用反斜線時要跳脫（例如 `C:\\\\path\\\\to\\\\repo`）。",
        `- 這個 agent 的預設專案是 \`${project}\`（可在片段外自行改 \`MNEMOSHELF_PROJECT\`）。`,
        "",
        "## 4. 驗證",
        "",
        '執行 `opencode run --standalone --print-logs "hello"`，在 stderr 看到 `[mnemoshelf]` 的 log；',
        "或在 TUI 輸入 `/memory` 看到「已連線」。",
      );
      break;
    }
    case "codex": {
      const snippet = buildHarnessConfig("codex-mcp", input);
      lines.push(
        "# 把 Mnemoshelf 接到 codex（給 agent 的安裝卡）",
        "",
        "你是協助使用者安裝 Mnemoshelf 的 agent。照下面做完，codex 會多出 Mnemoshelf 的六個 MCP 工具（本版沒有自動召回 hook）。",
        "",
        ...runtimeStep(input),
        "## 2. 把 MCP 片段貼進 `~/.codex/config.toml`",
        "",
        "```toml",
        snippet,
        "```",
        "",
        "## 3. 重啟 codex 並確認",
        "",
        "完整結束 codex 再啟動，然後執行 `codex mcp list`；清單應出現 `mnemoshelf`。",
        "",
        "## 4. 自動召回的本版限制",
        "",
        "本版 repo 未附 `recall.mjs`，**沒有**自動召回 hook；codex 只有 MCP 工具。",
        "請在專案的 `AGENTS.md` 明寫：需要查詢或寫入記憶時，主動呼叫 Mnemoshelf 的 MCP 工具，",
        "不要依賴模型自己記得。",
        "",
        `這個 agent 的預設專案是 \`${project}\`（片段中的 \`MNEMOSHELF_PROJECT\` 可自行改）。`,
      );
      break;
    }
    case "dsh": {
      const profile = resolveDshProfile(input.dshProfile);
      const snippet = buildHarnessConfig("dsh-profile", input);
      lines.push(
        "# 把 Mnemoshelf 接到 dsh（給 agent 的安裝卡）",
        "",
        "你是協助使用者安裝 Mnemoshelf 的 agent。照下面做完，dsh 會在回合前自動召回記憶、回合結束寫入回合卡。",
        "",
        ...runtimeStep(input),
        "## 2. 用 `dsh plugin` 指令安裝（優先做法）",
        "",
        "```sh",
        `dsh plugin --profile ${profile} add ${REPO_DIR_PLACEHOLDER}/packages/dsh-plugin`,
        `dsh plugin --profile ${profile} install`,
        "```",
        "",
        "`add` 的路徑要用**絕對路徑**，不要用 `./`（`dsh plugin add` 會用呼叫時的 cwd 解析相對路徑）。",
        "",
        "## 3. 或手動編輯 profile 的 `package.json`（兩段都要）",
        "",
        "把下面兩段合併進 `~/.dsh/profiles/` 底下的 profile 設定；既有內容原樣保留：",
        "",
        "```json",
        snippet,
        "```",
        "",
        "存檔後執行：",
        "",
        "```sh",
        `dsh plugin --profile ${profile} install`,
        "```",
        "",
        "## 4. 重啟並驗證",
        "",
        "重啟 `dsh web`，在 stderr 看到 `[mnemoshelf-dsh] connection` 表示外掛已載入。",
      );
      break;
    }
    case "other": {
      const snippet = buildHarnessConfig("mcp-generic", input);
      lines.push(
        "# 把 Mnemoshelf 接到其他 MCP client（給 agent 的安裝卡）",
        "",
        "你是協助使用者安裝 Mnemoshelf 的 agent。照下面做完，client 的工具清單會出現 Mnemoshelf 的六個 MCP 工具。",
        "",
        ...runtimeStep(input),
        "## 2. 把片段貼進 client 的 MCP 設定",
        "",
        "```json",
        snippet,
        "```",
        "",
        "各 client 的設定檔位置與欄位對照（Claude Desktop、MiniMax 等）見 `docs/agent-integration.md`",
        "的「其他 client 的欄位對照」；不確定位置時以 client 官方文件為準。",
        "",
        "## 3. 重啟 client 並確認",
        "",
        "完整關閉再啟動 client，確認工具清單有六個工具：`search`、`remember`、`recall`、",
        "`forget`、`list_roots`、`search_memories`。",
        "",
        `這個 agent 的預設專案是 \`${project}\`（可自行改 \`MNEMOSHELF_PROJECT\`）。`,
      );
      break;
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 複製內容的**唯一**入口：`install-card-*` → `buildInstallCard`；其餘 → `buildHarnessConfig`。
 * 設定頁的複製按鈕與預覽都必須呼叫這支，不得各自組字串。
 */
export function buildCopyText(kind: AgentGuideCopyKind, input: AgentGuideConnection): string {
  switch (kind) {
    case "install-card-opencode":
      return buildInstallCard("opencode", input);
    case "install-card-codex":
      return buildInstallCard("codex", input);
    case "install-card-dsh":
      return buildInstallCard("dsh", input);
    case "install-card-generic":
      return buildInstallCard("other", input);
    case "opencode-plugins":
    case "opencode-mcp":
    case "mcp-generic":
    case "codex-mcp":
    case "dsh-profile":
      return buildHarnessConfig(kind, input);
    default:
      throw new Error(`未知的複製種類：${String(kind)}`);
  }
}

// ---- 複製閘門 ----

/** 不允許複製的原因（穩定字串；UI 依此顯示文案）。 */
export type AgentGuideBlockedReason =
  | "runtime-missing"
  | "entry-missing"
  | "appimage"
  | "unknown-kind"
  | "clipboard-failed";

/** 所有可複製的種類（執行期白名單；IPC 參數不信任型別）。 */
export const AGENT_GUIDE_COPY_KINDS: readonly AgentGuideCopyKind[] = [
  "opencode-plugins",
  "opencode-mcp",
  "mcp-generic",
  "codex-mcp",
  "dsh-profile",
  "install-card-opencode",
  "install-card-codex",
  "install-card-dsh",
  "install-card-generic",
];

/** 需要 runtime.json 的種類。 */
const KINDS_REQUIRING_RUNTIME: ReadonlySet<AgentGuideCopyKind> = new Set([
  "opencode-mcp",
  "mcp-generic",
  "codex-mcp",
  "install-card-opencode",
  "install-card-codex",
  "install-card-dsh",
  "install-card-generic",
]);

/** 需要 MCP 入口腳本的種類（同時是受 AppImage 影響的種類）。 */
const KINDS_REQUIRING_ENTRY: ReadonlySet<AgentGuideCopyKind> = new Set([
  "opencode-mcp",
  "mcp-generic",
  "codex-mcp",
  "install-card-codex",
  "install-card-generic",
]);

/**
 * 複製前的閘門（純函式；檔案系統的檢查由呼叫端做完再傳布林值）。
 *
 * 優先序：`runtime-missing` → `entry-missing` → `appimage`。
 * 前兩者可修（開關／重新啟動／重新建置），AppImage 不可修，所以先講可修的。
 */
export function copyGate(input: {
  kind: AgentGuideCopyKind;
  /** `process.env.APPIMAGE`；AppImage 執行時有值。 */
  appImage: string | undefined;
  runtimeFileExists: boolean;
  entryPathExists: boolean;
}): { allowed: boolean; reason: AgentGuideBlockedReason | null } {
  if (!AGENT_GUIDE_COPY_KINDS.includes(input.kind)) {
    return { allowed: false, reason: "unknown-kind" };
  }
  if (KINDS_REQUIRING_RUNTIME.has(input.kind) && !input.runtimeFileExists) {
    return { allowed: false, reason: "runtime-missing" };
  }
  if (KINDS_REQUIRING_ENTRY.has(input.kind) && !input.entryPathExists) {
    return { allowed: false, reason: "entry-missing" };
  }
  if (KINDS_REQUIRING_ENTRY.has(input.kind) && input.appImage !== undefined && input.appImage.trim() !== "") {
    return { allowed: false, reason: "appimage" };
  }
  return { allowed: true, reason: null };
}
