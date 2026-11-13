/**
 * 環境變數解析（伺服器層）。
 *
 * | 變數 | 用途 | 預設 |
 * |---|---|---|
 * | `MNEMOSHELF_DATA_DIR` | 資料目錄（SQLite 檔所在） | OS 使用者資料目錄下的 `mnemoshelf` |
 * | `MNEMOSHELF_TOKEN` | REST 的 Bearer token | **無預設，未設即啟動失敗** |
 * | `MNEMOSHELF_MODEL_DIR` | 模型快取目錄（交給 embedder） | embedder 自己的預設（OS 使用者資料目錄） |
 * | `MNEMOSHELF_PORT` | 監聽埠 | `0`（隨機埠） |
 * | `MNEMOSHELF_WEB_DIR` | Web UI 靜態檔目錄 | 本 repo 的 `packages/web/dist` |
 * | `MNEMOSHELF_MEMORY_BACKFILL` | 啟動時是否回填既有記憶向量（`on`／`off`） | `on` |
 * | `MNEMOSHELF_INDEX_RATE` | 索引限速 `off`／`normal`／`low`（索引時每檔之間休眠） | `off` |
 * | `MNEMOSHELF_AGENT_DISCOVERY` | 是否寫出 agent 連線資訊檔（`on`／`off`；檔案含 token） | `off` |
 * | `MNEMOSHELF_RUNTIME_FILE` | 連線資訊檔路徑（覆寫 `<dataDir>/runtime.json`） | `<dataDir>/runtime.json` |
 * | `MNEMOSHELF_FFMPEG_PATH` | 影片解碼器 ffmpeg 執行檔（絕對路徑；須與 ffprobe 成對） | 未設定＝不啟用影片解碼 |
 * | `MNEMOSHELF_FFPROBE_PATH` | 影片解碼器 ffprobe 執行檔（絕對路徑；須與 ffmpeg 成對） | 未設定＝不啟用影片解碼 |
 * | `MNEMOSHELF_FFMPEG_DIR` | 影片解碼器目錄（內含平台檔名 ffmpeg／ffprobe；上面兩個變數優先） | 未設定 |
 * | `MNEMOSHELF_VIDEO_MAX_FILE_BYTES` | 影片單檔大小上限（bytes；per-root 持久化屬 C2） | 512 MiB |
 *
 * MCP stdio 入口（`loadMcpConfig`）另有自己的三個變數：`MNEMOSHELF_URL`、`MNEMOSHELF_TOKEN`
 * （**兩個都設定**才會直接使用；缺任何一個就改讀 `runtime.json`）與 `MNEMOSHELF_PROJECT`
 * （選配的預設專案名稱；供 `remember` 與 `search_memories` 在工具參數沒帶 `project` 時使用）。
 *
 * 另有三個**由 embedder 直接讀取**（不經此處解析，本表僅登錄以免漏查；見
 * `@mnemoshelf/embedder-transformers` 的 `device.ts`）：
 *
 * | 變數 | 用途 | 預設 |
 * |---|---|---|
 * | `MNEMOSHELF_EMBED_DEVICE` | 嵌入裝置 `cpu`／`auto`／`dml`／`coreml`／`webgpu`（明示 `auto`＝Windows 試 dml、macOS 試 coreml；WebGPU 需明示且首輪限 macOS arm64） | `cpu` |
 * | `MNEMOSHELF_EMBED_DML_DEVICE_ID` | DirectML adapter 索引（非負整數，多顯卡時指定獨顯） | `0`（預設顯示卡） |
 * | `MNEMOSHELF_EMBED_ORT_LOG` | ONNX Runtime log 等級 `0`–`4`（`0`＝verbose；診斷用） | 未設定（不覆寫 ORT 預設） |
 *
 * 另有**只在 build 時使用**的變數（不由本檔解析，本表僅登錄）：
 *
 * | 變數 | 用途 | 預設 |
 * |---|---|---|
 * | `MNEMOSHELF_BUILD_COMMIT` | build 時 `git rev-parse HEAD` 不可用的 fallback commit（`scripts/build-info.mjs`）；服務讀不到 `dist/build-info.json` 時，也用它作為 `GET /health` 的 `build` 後備 | `unknown` |
 *
 * token 刻意不自動產生：自動生成會讓使用者誤以為已經有保護，實際上 token 沒人知道、
 * 也沒人能通過驗證。未設時直接失敗並提示產生方式（`MissingTokenError`）。
 */
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MissingMcpConfigError, MissingTokenError, ValidationError } from "./errors.js";

/** 預設綁定的位址：loopback（可由使用者透過 `MNEMOSHELF_HOST` 覆寫並承擔對外風險）。 */
export const LOOPBACK_HOST = "127.0.0.1";

/** 瀏覽資料夾的預設範圍：`home` 限制在家目錄、`custom` 限自訂目錄、`unrestricted` 不限範圍。 */
export type BrowseScope = "home" | "custom" | "unrestricted";

/** 判斷監聽位址是否屬於本機 loopback。 */
export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("127.")
  );
}

/**
 * 影片單檔大小上限的預設值（bytes；512 MiB）。
 *
 * 刻意**不 import `@mnemoshelf/core`**：本檔會被 MCP stdio 入口（`mcp/runtime-connection.ts`
 * 匯入 `loadMcpConfig`）載入，而 core root entry 會拉進 SQLite 原生依賴。目前 MCP 經
 * `APP_VERSION`（app.ts）已載入 core，是既有狀況、不在本輪範圍；但設定層不該再多一條
 * 啟動成本。兩邊同值由 `test/config.video.test.ts` 對照 core 的常數鎖定。
 */
export const DEFAULT_VIDEO_MAX_FILE_BYTES = 512 * 1024 * 1024;

/** 索引限速等級（`MNEMOSHELF_INDEX_RATE`）。 */
export type IndexRate = "off" | "normal" | "low";

/**
 * 各限速等級在「檔案與檔案之間」插入的休眠毫秒。
 *
 * 為什麼是這種 duty-cycle 而不是降低模型執行緒數：推論成本主要在 native 端，一次 `Run`
 * 無法中斷；在檔案邊界休眠最便宜、可取消，也完全不會改變檢索品質（切塊、模型、
 * 批次視窗都不動）。`normal` 讓出一點 CPU 給 UI／其他程式，`low` 明顯降低索引佔用
 * （總時間變長是預期代價）。
 */
export const INDEX_RATE_BETWEEN_FILES_MS: Readonly<Record<IndexRate, number>> = {
  off: 0,
  normal: 50,
  low: 250,
};

/**
 * 影片解碼器 binary（絕對路徑；**不由系統 PATH 解析**）。
 *
 * 為什麼不從 PATH 找：A1 的證據顯示「開發機剛好有 ffmpeg」不是可配送的保證；
 * 明確設定才能讓打包版把 binary 放在 `extraResources` 再指過來，也讓 CI 在沒有
 * binary 時得到「未設定」而不是不確定的行為。
 */
export interface MediaDecoderBinaries {
  /** ffmpeg 執行檔絕對路徑。 */
  ffmpegPath: string;
  /** ffprobe 執行檔絕對路徑。 */
  ffprobePath: string;
}

export interface ServerConfig {
  /** 資料目錄（已解析為絕對路徑）。 */
  dataDir: string;
  /** SQLite 資料庫檔路徑（`<dataDir>/mnemoshelf.db`）。 */
  dbPath: string;
  token: string;
  /** 模型快取目錄；未設定時回傳 undefined，由 embedder 決定預設。 */
  modelDir: string | undefined;
  /** 監聽埠；0 表示由 OS 指派。 */
  port: number;
  /** Web UI 靜態檔目錄（已解析為絕對路徑；不存在時 API 仍正常，靜態路徑回 404）。 */
  webDir: string;
  /**
   * 啟動時是否回填既有記憶向量（`MNEMOSHELF_MEMORY_BACKFILL=on|off`，預設 `on`）。
   *
   * `off` 只停**啟動回填**：新寫入的記憶仍會在建立後 enqueue 嵌入；既有 pending／failed／stale
   * 資料留到下一次以 `on` 啟動時才回填。
   */
  memoryBackfill: boolean;
  /**
   * 索引限速（`MNEMOSHELF_INDEX_RATE=off|normal|low`，預設 `off`）。
   *
   * `off`＝現行行為（檔案之間不休眠）；`normal`／`low` 在檔案邊界休眠
   * （見 `INDEX_RATE_BETWEEN_FILES_MS`）。非法值直接拒絕啟動。
   */
  indexRate: IndexRate;
  /**
   * 是否寫出 agent 連線資訊檔（`MNEMOSHELF_AGENT_DISCOVERY=on|off`，預設 `off`）。
   *
   * 檔案含 Bearer token；只有使用者（或桌面版設定）明確開啟時才寫。關閉時啟動會順便清除
   * 上次殘留的檔案，避免「已關閉」的功能仍留下有效 token。
   */
  agentDiscovery: boolean;
  /**
   * 連線資訊檔路徑（`MNEMOSHELF_RUNTIME_FILE`，預設 `<dataDir>/runtime.json`）。
   *
   * 自訂 `MNEMOSHELF_DATA_DIR` 的外部程式要能算出同一個位置；算不出來時請明確設定這個變數
   * （見 `docs/agent-integration.md`）。
   */
  runtimeFile: string;
  /**
   * 影片解碼器 binary（`MNEMOSHELF_FFMPEG_PATH`／`MNEMOSHELF_FFPROBE_PATH`，或
   * `MNEMOSHELF_FFMPEG_DIR` 目錄下的平台檔名）。
   *
   * 未設定時為 `undefined`：**不建立 decoder**，服務不宣告影片能力（既有行為不變）。
   * 設定但 binary 缺失／損毀時仍會建立 decoder；啟動時的可用性檢查回 false，
   * 服務照常啟動、影片路徑具名失敗（見 `docs/roots-and-privacy.md`）。
   */
  mediaDecoder: MediaDecoderBinaries | undefined;
  /**
   * 影片單檔大小上限（bytes；`MNEMOSHELF_VIDEO_MAX_FILE_BYTES`，預設 512 MiB）。
   *
   * 只套用影片（掃描、有界快照與播放端點共用同一個值）；通用 `maxFileBytes` 的
   * 10 MiB 不套用影片。per-root 持久化與 UI 入口屬 C2，本輪只有行程層預設值。
   */
  videoMaxFileBytes: number;
  /** 監聽位址（`MNEMOSHELF_HOST`，預設 `127.0.0.1`）。非 loopback 會放寬連線來源檢查，風險由使用者承擔。 */
  host: string;
  /** 是否允許匿名免 token 存取（`MNEMOSHELF_ALLOW_ANONYMOUS=on|off`，預設 `off`）。 */
  allowAnonymous: boolean;
  /** 瀏覽資料夾端點的範圍（`MNEMOSHELF_BROWSE_SCOPE=home|custom|unrestricted`，預設 `home`）。 */
  browseScope: BrowseScope;
  /** `browseScope === "custom"` 時允許瀏覽的根目錄清單（`MNEMOSHELF_BROWSE_ROOTS`，以 `path.delimiter` 分隔）。 */
  browseRoots: string[];
  /** 瀏覽資料夾是否套用敏感路徑黑名單（`MNEMOSHELF_BROWSE_RESPECT_BLACKLIST=on|off`，預設 `on`）。 */
  browseRespectBlacklist: boolean;
}

/**
 * Web UI build 產物的預設位置：本檔所在的套件目錄往上兩層再進 `web/dist`。
 *
 * `src/config.ts` 與 build 後的 `dist/config.js` 都位於 `packages/server/` 底下，
 * 因此兩種情況下 `../../web/dist` 都指向 `packages/web/dist`（不硬寫分隔符）。
 */
function defaultWebDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
}

/** OS 使用者資料目錄（跨平台，不硬寫分隔符；與 embedder 的預設邏輯一致）。 */
function osUserDataDir(home: string): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData !== undefined && appData.trim() !== "" ? appData : path.join(home, "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  const xdg = process.env.XDG_DATA_HOME;
  return xdg !== undefined && xdg.trim() !== "" ? xdg : path.join(home, ".local", "share");
}

/** 平台上的解碼器執行檔檔名（Windows 需要 `.exe`）。 */
export function mediaDecoderBinaryName(base: "ffmpeg" | "ffprobe", platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${base}.exe` : base;
}

/** 空字串（或全空白）視為「未設定」，與本檔其他環境變數的慣例一致。 */
function hasSetting(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * 解析影片解碼器 binary 設定。
 *
 * 規則：
 * - `MNEMOSHELF_FFMPEG_PATH`／`MNEMOSHELF_FFPROBE_PATH` **必須成對**；只設一個直接拒絕啟動
 *   （解碼器同時需要兩支程式，只設一支等於設定沒生效，最難查）。
 * - 兩個都設定時以它們為準（`MNEMOSHELF_FFMPEG_DIR` 被忽略）。
 * - 只設目錄時，以平台檔名組出兩支路徑（`ffmpeg.exe`／`ffprobe.exe` 或 `ffmpeg`／`ffprobe`）。
 * - 完全未設定 → `undefined`（不啟用影片解碼）。
 *
 * 這裡**不檢查檔案是否存在**：缺失／損毀是啟動後可用性檢查的責任（服務仍要能啟動）。
 */
export function resolveMediaDecoderBinaries(env: NodeJS.ProcessEnv): MediaDecoderBinaries | undefined {
  const ffmpegSetting = env.MNEMOSHELF_FFMPEG_PATH;
  const ffprobeSetting = env.MNEMOSHELF_FFPROBE_PATH;
  const dirSetting = env.MNEMOSHELF_FFMPEG_DIR;

  if (hasSetting(ffmpegSetting) !== hasSetting(ffprobeSetting)) {
    throw new ValidationError(
      "MNEMOSHELF_FFMPEG_PATH",
      "必須與 MNEMOSHELF_FFPROBE_PATH 成對設定（只設一個無法解碼；也可改用 MNEMOSHELF_FFMPEG_DIR）",
    );
  }
  if (hasSetting(ffmpegSetting) && hasSetting(ffprobeSetting)) {
    return { ffmpegPath: path.resolve(ffmpegSetting), ffprobePath: path.resolve(ffprobeSetting) };
  }
  if (hasSetting(dirSetting)) {
    const dir = path.resolve(dirSetting);
    return {
      ffmpegPath: path.join(dir, mediaDecoderBinaryName("ffmpeg")),
      ffprobePath: path.join(dir, mediaDecoderBinaryName("ffprobe")),
    };
  }
  return undefined;
}

/** 解析影片單檔大小上限（bytes）；非法值直接拒絕啟動。 */
export function resolveVideoMaxFileBytes(env: NodeJS.ProcessEnv): number {
  const setting = env.MNEMOSHELF_VIDEO_MAX_FILE_BYTES;
  if (!hasSetting(setting)) return DEFAULT_VIDEO_MAX_FILE_BYTES;
  const parsed = Number(setting);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError("MNEMOSHELF_VIDEO_MAX_FILE_BYTES", "必須是正整數（bytes）");
  }
  return parsed;
}

function parseOnOff(env: NodeJS.ProcessEnv, key: string, defaultValue: boolean): boolean {
  const setting = env[key];
  if (setting === undefined || setting.trim() === "") return defaultValue;
  const normalized = setting.trim().toLowerCase();
  if (normalized !== "on" && normalized !== "off") {
    throw new ValidationError(key, "必須是 on 或 off");
  }
  return normalized === "on";
}

/** 從環境變數讀出設定；非匿名模式下缺少 token 時丟 `MissingTokenError`。 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const allowAnonymous = parseOnOff(env, "MNEMOSHELF_ALLOW_ANONYMOUS", false);
  const rawToken = env.MNEMOSHELF_TOKEN;
  const token = rawToken !== undefined && rawToken.trim() !== "" ? rawToken : "";
  if (!allowAnonymous && token === "") throw new MissingTokenError();

  const hostSetting = env.MNEMOSHELF_HOST;
  const host = hostSetting !== undefined && hostSetting.trim() !== "" ? hostSetting.trim() : LOOPBACK_HOST;
  if (/\s/.test(host)) {
    throw new ValidationError("MNEMOSHELF_HOST", "不得包含空白字元");
  }

  const scopeSetting = env.MNEMOSHELF_BROWSE_SCOPE;
  let browseScope: BrowseScope = "home";
  if (scopeSetting !== undefined && scopeSetting.trim() !== "") {
    const normalized = scopeSetting.trim().toLowerCase();
    if (normalized !== "home" && normalized !== "custom" && normalized !== "unrestricted") {
      throw new ValidationError("MNEMOSHELF_BROWSE_SCOPE", "必須是 home、custom 或 unrestricted");
    }
    browseScope = normalized;
  }

  const browseRootsSetting = env.MNEMOSHELF_BROWSE_ROOTS;
  const browseRoots =
    browseRootsSetting !== undefined && browseRootsSetting.trim() !== ""
      ? browseRootsSetting
          .split(path.delimiter)
          .map((item) => item.trim())
          .filter((item) => item !== "")
          .map((item) => path.resolve(item))
      : [];
  if (browseScope === "custom" && browseRoots.length === 0) {
    throw new ValidationError("MNEMOSHELF_BROWSE_ROOTS", "當 MNEMOSHELF_BROWSE_SCOPE=custom 時必須至少指定一個目錄");
  }

  const browseRespectBlacklist = parseOnOff(env, "MNEMOSHELF_BROWSE_RESPECT_BLACKLIST", true);

  const dataDirSetting = env.MNEMOSHELF_DATA_DIR;
  const dataDir =
    dataDirSetting !== undefined && dataDirSetting.trim() !== ""
      ? path.resolve(dataDirSetting)
      : path.join(osUserDataDir(homedir()), "mnemoshelf");

  const modelDirSetting = env.MNEMOSHELF_MODEL_DIR;
  const modelDir = modelDirSetting !== undefined && modelDirSetting.trim() !== "" ? path.resolve(modelDirSetting) : undefined;

  const portSetting = env.MNEMOSHELF_PORT;
  let port = 0;
  if (portSetting !== undefined && portSetting.trim() !== "") {
    const parsed = Number(portSetting);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new ValidationError("MNEMOSHELF_PORT", "必須是 0–65535 的整數");
    }
    port = parsed;
  }

  const webDirSetting = env.MNEMOSHELF_WEB_DIR;
  const webDir =
    webDirSetting !== undefined && webDirSetting.trim() !== "" ? path.resolve(webDirSetting) : defaultWebDir();

  // 啟動回填 opt-out（預設 on）。只接受 on／off（大小寫不拘）；其他值直接拒絕啟動。
  const backfillSetting = env.MNEMOSHELF_MEMORY_BACKFILL;
  let memoryBackfill = true;
  if (backfillSetting !== undefined && backfillSetting.trim() !== "") {
    const normalized = backfillSetting.trim().toLowerCase();
    if (normalized !== "on" && normalized !== "off") {
      throw new ValidationError("MNEMOSHELF_MEMORY_BACKFILL", "必須是 on 或 off");
    }
    memoryBackfill = normalized === "on";
  }

  // 索引限速（預設 off＝現行行為）。只接受 off／normal／low（大小寫不拘）；
  // 與其他開關一致：非法值直接拒絕啟動，而不是默默退回預設（使用者設了卻沒生效最難查）。
  const indexRateSetting = env.MNEMOSHELF_INDEX_RATE;
  let indexRate: IndexRate = "off";
  if (indexRateSetting !== undefined && indexRateSetting.trim() !== "") {
    const normalized = indexRateSetting.trim().toLowerCase();
    if (normalized !== "off" && normalized !== "normal" && normalized !== "low") {
      throw new ValidationError("MNEMOSHELF_INDEX_RATE", "必須是 off、normal 或 low");
    }
    indexRate = normalized;
  }

  // Agent 連線資訊檔（預設 off）：檔案含全權 token，只在明確開啟時寫出。
  // 與其他 on／off 開關一致：非法值直接拒絕啟動（大小寫不拘）。
  const discoverySetting = env.MNEMOSHELF_AGENT_DISCOVERY;
  let agentDiscovery = false;
  if (discoverySetting !== undefined && discoverySetting.trim() !== "") {
    const normalized = discoverySetting.trim().toLowerCase();
    if (normalized !== "on" && normalized !== "off") {
      throw new ValidationError("MNEMOSHELF_AGENT_DISCOVERY", "必須是 on 或 off");
    }
    agentDiscovery = normalized === "on";
  }

  const runtimeFileSetting = env.MNEMOSHELF_RUNTIME_FILE;
  const runtimeFile =
    runtimeFileSetting !== undefined && runtimeFileSetting.trim() !== ""
      ? path.resolve(runtimeFileSetting)
      : path.join(dataDir, "runtime.json");

  // 影片解碼器與上限：未設定 decoder 時維持既有行為（不宣告影片能力）。
  const mediaDecoder = resolveMediaDecoderBinaries(env);
  const videoMaxFileBytes = resolveVideoMaxFileBytes(env);

  return {
    dataDir,
    dbPath: path.join(dataDir, "mnemoshelf.db"),
    token,
    modelDir,
    port,
    webDir,
    memoryBackfill,
    indexRate,
    agentDiscovery,
    runtimeFile,
    mediaDecoder,
    videoMaxFileBytes,
    host,
    allowAnonymous,
    browseScope,
    browseRoots,
    browseRespectBlacklist,
  };
}

/** MCP stdio 入口的連線設定（`MNEMOSHELF_URL` + `MNEMOSHELF_TOKEN`）。 */
export interface McpConfig {
  url: string;
  token: string;
  /**
   * 這個 MCP 行程的預設專案（選配；來自 `MNEMOSHELF_PROJECT`）。
   *
   * 未設定（或只有空白）時為 `undefined`；`remember` 解析不到工具參數時會依序退回它、
   * 再退回 `process.cwd()` 的 basename（見 `mcp/stdio.ts` 的 `resolveProjectName`）。
   */
  project?: string;
}

/**
 * 讀出 MCP 入口設定；`MNEMOSHELF_URL`／`MNEMOSHELF_TOKEN` 缺少者列入錯誤的 `missing`
 * （呼叫端據此改讀 `runtime.json`；只有兩個都在時才會直接使用環境變數）。
 *
 * `MNEMOSHELF_PROJECT` 是選配的預設專案名稱（trim 後非空才採用；純空白視為未設定），
 * 供 `remember` 與 `search_memories` 在工具參數沒帶 `project` 時使用。
 */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const missing: string[] = [];
  const url = env.MNEMOSHELF_URL;
  const token = env.MNEMOSHELF_TOKEN;
  if (url === undefined || url.trim() === "") missing.push("MNEMOSHELF_URL");
  if (token === undefined || token.trim() === "") missing.push("MNEMOSHELF_TOKEN");
  if (missing.length > 0) throw new MissingMcpConfigError(missing);

  const projectSetting = env.MNEMOSHELF_PROJECT;
  const project = projectSetting !== undefined && projectSetting.trim() !== "" ? projectSetting.trim() : undefined;

  return {
    url: url!.replace(/\/+$/, ""),
    token: token!,
    ...(project === undefined ? {} : { project }),
  };
}
