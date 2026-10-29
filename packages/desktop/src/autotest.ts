/**
 * 自動驗收：用一個真實視窗把桌面殼的行為逐步跑一遍，每步截圖並寫出 `report.json`。
 *
 * 只在設了 `MNEMOSHELF_AUTOTEST`（逗號分隔的情境清單）時啟用；由 `scripts/smoke.mjs` 驅動。
 * **這不是產品功能**，是可驗證性工具：操作的是真正的 UI（在 renderer 內以 DOM 事件驅動），
 * 會用到的「系統匣／結束」入口也是產品程式碼匯出的同一個函式。
 *
 * 情境：
 * - `bootstrap`：首次啟動的模型下載畫面（進度）→ 等就緒；`MNEMOSHELF_AUTOTEST_KILL_AFTER_PROGRESS=1`
 *   時只確認「進度出現」就停在原地，讓驅動腳本砍掉行程（模擬中斷）。
 * - `app`：桌面模式下不出現手動貼 token 的畫面，服務已連線，401 為零。
 * - `index`：加入測試資料夾 → 索引 → 文字預覽 → 搜尋（沿用 M4 打包 spike 的流程）。
 *   不含圖片縮圖：樣本圖片的模態預設未開，不會被索引，縮圖端點由 spike 卡單獨驗過。
 * - `autostart`：設定介面的開機自啟開關（開啟／關閉，並檢查落地檔案）。
 * - `agent`：設定頁的 Agent 連線資訊（預設開啟、狀態顯示可用、複製內容含 url 與 token、
 *   關閉後立即刪除 runtime 檔、重新開啟需重啟才寫出）。複製到的 token 只用於斷言，不進報告。
 * - `agent-guide`：「連接 Agent」頁的四個 tab（opencode／codex／dsh／other）逐一截圖，
 *   斷言偵測行是三態之一、預覽非空；複製安裝卡與片段到真剪貼簿，斷言含必要字串且**不含 token**，
 *   最後驗「剪貼簿內容 === 預覽文字」。剪貼簿內容不進報告或 log。
 * - `hidden`：以 `--hidden` 啟動時，視窗建好、UI 載入完、第一次 `ready-to-show` 之後
 *   仍不可見（開機自啟不彈出視窗）。**必須**以 `--hidden` 啟動才會通過，因此不在 `all` 裡。
 * - `tray`：關窗縮到系統匣（程序存活、視窗隱藏）→ 從系統匣選單「離開」整個結束。
 */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { BrowserWindow, clipboard, type Tray } from "electron";
import type { BootstrapState } from "./model-bootstrap.js";

/** 單一步驟的結果。 */
export interface AutotestStepResult {
  scenario: string;
  name: string;
  ok: boolean;
  detail: string;
  at: string;
}

export interface AutotestOptions {
  /** 逗號分隔的情境清單，或 `all`。 */
  scenarios: string;
  window: BrowserWindow | null;
  serverUrl: string;
  bootstrap: () => BootstrapState | null;
  /** 模型快取目錄（報告要列檔案，並比對索引前後的清單）。 */
  modelDir: string;
  tray: Tray | null;
  /** 系統匣選單的項目（由 main 建立選單時記錄，報告與斷言用）。 */
  trayMenuItems: readonly string[];
  /** Linux 的 autostart 檔路徑（`autostart` 情境直接檢查它真的被寫出／刪掉）。 */
  autostartFile: string | null;
  /** Agent 連線資訊檔路徑（`agent` 情境檢查寫出／立即刪除）。 */
  runtimeFile: string;
  outputDir: string;
  sampleRoot: string;
  sampleTextName: string;
  sampleImageName: string;
  searchQuery: string;
  stepTimeoutMs: number;
  indexTimeoutMs: number;
  bootstrapTimeoutMs: number;
  /** 只確認進度出現就停住（等外部砍掉行程）。 */
  killAfterProgress: boolean;
  /** 這次啟動是不是帶了 `--hidden`（`hidden` 情境的斷言前提）。 */
  startHidden: boolean;
  /** 主視窗第一次 `ready-to-show` 的訊號（`hidden` 情境要等它之後才斷言）。 */
  windowReadyToShow: Promise<void>;
  environment?: Record<string, unknown>;
  rendererMessages?: readonly string[];
  /** 系統匣的「開啟主視窗」（產品程式碼匯出的同一個函式）。 */
  showMainWindow: (reason: string) => void;
  /** 系統匣的「離開」（產品程式碼匯出的同一個函式）。 */
  exitFromTray: () => void;
  /** 另外啟動一個同樣 userData 的實例（單一實例鎖的驗收用）；回傳它的退出碼。 */
  spawnSecondInstance: () => Promise<{ code: number | null; signal: string | null }>;
  /** 目前的存取 token（只用於 `browser` 情境模擬使用者手動貼上；不會寫進報告）。 */
  browserToken: string | null;
}

export interface AutotestResult {
  ok: boolean;
  failure: string | null;
  steps: AutotestStepResult[];
  reportPath: string;
  /** 非 null 時，主流程要用這個退出碼結束。 */
  exitCode: number | null;
}

/**
 * 全部情境（`all` 展開後的順序；`tray` 一定最後，因為它會結束行程）。
 *
 * `agent-guide` 必須排在 `agent` **之前**：`agent` 情境為了驗「關閉立即刪檔／重新開啟需重啟」
 * 會把 runtime 檔刪掉且不補寫；`agent-guide` 的複製與「不含 token」斷言需要 runtime 檔存在。
 */
export const ALL_SCENARIOS = ["bootstrap", "app", "agent-guide", "single", "browser", "index", "autostart", "agent", "tray"] as const;

/**
 * 只在特定啟動方式下才成立的情境，**不**含在 `all` 裡（跑 `all` 的啟動方式不一定符合前提）：
 *
 * - `hidden`：必須以 `--hidden` 啟動，驗「開機自啟的登入啟動不會彈出視窗」。
 */
export const OPT_IN_SCENARIOS = ["hidden"] as const;

/** 情境的執行順序：opt-in 情境插在 `tray` 之前（`tray` 會結束行程，必須最後）。 */
function executionOrder(): string[] {
  const order: string[] = [...ALL_SCENARIOS];
  order.splice(order.length - 1, 0, ...OPT_IN_SCENARIOS);
  return order;
}

const POLL_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等一個已經在跑的 promise；逾時丟錯（等主行程的訊號用，不讓驗收無限卡住）。 */
async function waitForPromise(promise: Promise<void>, timeoutMs: number, description: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`等待逾時（${description}，已等 ${Math.round(timeoutMs / 1000)} 秒）`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 在 renderer 內求值（`executeJavaScript` 不受 `script-src 'self'` 的 CSP 影響，已實測）。 */
async function evaluate<T>(window: BrowserWindow, expression: string): Promise<T> {
  return (await window.webContents.executeJavaScript(expression, true)) as T;
}

/** 輪詢直到表達式為真；逾時丟錯（附上等待的說明）。 */
async function waitFor(
  window: BrowserWindow,
  expression: string,
  description: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  let lastLogAt = startedAt;
  for (;;) {
    let value = false;
    try {
      value = (await evaluate<unknown>(window, `Boolean(${expression})`)) === true;
    } catch {
      // 頁面正在換頁／重繪時求值可能失敗，下一輪再試。
      value = false;
    }
    if (value) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待逾時（${description}，已等 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
    }
    if (Date.now() - lastLogAt > 15000) {
      lastLogAt = Date.now();
      console.log(`[autotest] 仍在等待：${description}（已等 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
    }
    await delay(POLL_MS);
  }
}

/** 依可見文字點擊按鈕／連結（全字比對，取文件順序第一個）。 */
function clickByTextExpression(text: string): string {
  return `(() => {
  const wanted = ${JSON.stringify(text)};
  const nodes = [...document.querySelectorAll("button, a, [role=\\"button\\"]")];
  const target = nodes.find((node) => (node.textContent || "").trim() === wanted);
  if (!target) return false;
  target.click();
  return true;
})()`;
}

/** 畫面上有沒有一個文字完全等於 `text` 的按鈕。 */
function buttonExistsExpression(text: string): string {
  return `[...document.querySelectorAll("button")].some((node) => (node.textContent || "").trim() === ${JSON.stringify(text)})`;
}

/** 讀出畫面上第一個 `role="alert"` 的文字（沒有時回 null）。 */
const ACTIVE_ALERT_EXPRESSION = `(() => {
  const alerts = [...document.querySelectorAll('[role="alert"]')];
  const alert = alerts.find((node) => (node.textContent || "").trim() !== "");
  return alert ? alert.textContent.trim() : null;
})()`;

/** 依 CSS 選擇器點擊。 */
function clickSelectorExpression(selector: string): string {
  return `(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  if (!target) return false;
  target.click();
  return true;
})()`;
}

/** 設定 React 受控輸入的值（用原生 setter ＋ input 事件，否則 React 不會更新 state）。 */
function setInputExpression(selector: string, value: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;
}

/** 取得某個元素的屬性（例如圖片的 naturalWidth）。 */
function elementInfoExpression(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  return {
    tag: el.tagName,
    alt: el.getAttribute("alt"),
    naturalWidth: el.naturalWidth ?? null,
    naturalHeight: el.naturalHeight ?? null,
    textLength: (el.textContent || "").length,
    textHead: (el.textContent || "").slice(0, 200),
  };
})()`;
}

/**
 * 截一張圖並寫檔，回傳檔案路徑。
 *
 * `MNEMOSHELF_AUTOTEST_SKIP_SHOTS=1` 時直接回傳空字串（不呼叫 `capturePage`、不寫檔）：
 * GitHub runner 的 xvfb／軟體渲染環境可能讓 `capturePage` 丟出 `UnknownVizError`，
 * CI 只需要流程的斷言結果，不需要截圖。
 *
 * 截圖失敗一律吞掉並印一行記錄，**不讓整個 autotest 失敗**；本機沒有這個 env 時
 * 仍照常截圖。回傳空字串代表「這次沒有圖」，報告最後會過濾掉。
 */
async function shoot(window: BrowserWindow, outputDir: string, name: string): Promise<string> {
  if (process.env.MNEMOSHELF_AUTOTEST_SKIP_SHOTS === "1") return "";
  try {
    const image = await window.webContents.capturePage();
    const file = path.join(outputDir, name);
    await fs.writeFile(file, image.toPNG());
    return file;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[autotest] 截圖失敗（${name}）：${message}`);
    return "";
  }
}

/** 遞迴列目錄（供報告引用模型快取的落地檔案）。 */
async function listDir(dir: string): Promise<{ files: { relPath: string; bytes: number }[]; totalBytes: number }> {
  const files: { relPath: string; bytes: number }[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const stat = await fs.stat(full).catch(() => null);
        files.push({ relPath: path.relative(dir, full), bytes: stat?.size ?? 0 });
      }
    }
  };
  await walk(dir);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

/** 解析情境清單。 */
export function parseScenarios(value: string): string[] {
  const order = executionOrder();
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "all") return [...ALL_SCENARIOS];
  const requested = trimmed
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const unknown = requested.filter((item) => !order.includes(item));
  if (unknown.length > 0) {
    throw new Error(`不認得的情境：${unknown.join("、")}（可用：${order.join("、")}）`);
  }
  // 一律照 executionOrder 的順序跑（tray 會結束行程，必須最後）。
  return order.filter((item) => requested.includes(item));
}

/** 跑指定的情境；不論成敗都寫出報告，最後以結果回報。 */
export async function runAutotest(options: AutotestOptions): Promise<AutotestResult> {
  await fs.mkdir(options.outputDir, { recursive: true });
  const steps: AutotestStepResult[] = [];
  const shots: string[] = [];
  const bootstrapHistory: BootstrapState[] = [];
  let failure: string | null = null;
  let exitCode: number | null = 0;
  let trayQuitRequested = false;
  let previewText = "";
  let modelDirListingBeforeIndex: unknown = null;

  const record = (scenario: string, name: string, ok: boolean, detail: string): void => {
    steps.push({ scenario, name, ok, detail, at: new Date().toISOString() });
    console.log(`[autotest] ${ok ? "✓" : "✗"} [${scenario}] ${name}：${detail}`);
  };

  /** 記錄 bootstrap 狀態的變化（報告用）。 */
  const snapshotBootstrap = (): BootstrapState | null => {
    const state = options.bootstrap();
    if (state !== null) {
      const last = bootstrapHistory[bootstrapHistory.length - 1];
      if (
        last === undefined ||
        last.phase !== state.phase ||
        last.progress.percent !== state.progress.percent ||
        state.phase === "ready" ||
        state.phase === "failed"
      ) {
        bootstrapHistory.push(state);
      }
    }
    return state;
  };

  const scenarios = parseScenarios(options.scenarios);
  const window = options.window;

  /** 等 bootstrap 進入指定階段（在主行程側輪詢，不受 renderer 換頁影響）。 */
  const waitForBootstrapPhase = async (phases: readonly string[], timeoutMs: number): Promise<BootstrapState> => {
    const startedAt = Date.now();
    for (;;) {
      const state = snapshotBootstrap();
      if (state !== null && phases.includes(state.phase)) return state;
      if (state !== null && state.phase === "failed") return state;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`等待逾時（模型階段 ${phases.join("／")}，最後狀態：${state?.phase ?? "未知"}）`);
      }
      await delay(POLL_MS);
    }
  };

  const run = async (scenario: string, name: string, body: () => Promise<string>): Promise<void> => {
    if (failure !== null) return;
    try {
      const detail = await body();
      record(scenario, name, true, detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record(scenario, name, false, message);
      failure = `[${scenario}] ${name}：${message}`;
      if (window !== null && !window.isDestroyed()) {
        await shoot(window, options.outputDir, `99-失敗-${scenario}-${name}.png`).catch(() => undefined);
      }
    }
  };

  const requireWindow = (): BrowserWindow => {
    if (window === null || window.isDestroyed()) throw new Error("這個情境需要視窗，但目前沒有可用視窗");
    return window;
  };

  /**
   * `bootstrap`：確認首次啟動的下載進度畫面。
   *
   * `killAfterProgress`（中斷模擬）時只要看到「有進度」就停在這裡，由驅動腳本砍掉行程。
   * 模型已經在磁碟上時（重複跑同一個 userData）不會出現下載畫面，這時只確認狀態就是 `ready`。
   */
  if (scenarios.includes("bootstrap")) {
    let needsDownload = false;
    await run("bootstrap", "模型狀態", async () => {
      const win = requireWindow();
      // 先等主行程的檢查有結果（checking → ready／downloading／failed）再決定要驗哪一條路徑。
      const current = await waitForBootstrapPhase(["ready", "downloading", "verifying", "failed"], options.stepTimeoutMs);
      if (current.phase === "ready") {
        shots.push(await shoot(win, options.outputDir, "01-bootstrap-ready-already.png"));
        return `模型已就緒（磁碟上已有快取，本次沒有下載）：${current.message}`;
      }
      needsDownload = true;
      await waitFor(win, `document.querySelector("#mnemoshelf-bootstrap") !== null`, "模型下載畫面出現", options.stepTimeoutMs);
      shots.push(await shoot(win, options.outputDir, "01-bootstrap-screen.png"));
      return `已顯示模型下載畫面（phase=${current.phase}）`;
    });

    if (needsDownload) {
      await run("bootstrap", "下載進度", async () => {
        const win = requireWindow();
        await waitFor(
          win,
          `(() => { const el = document.querySelector("#mnemoshelf-bootstrap-progress"); return el !== null && el.getAttribute("data-total") !== "0"; })()`,
          "下載進度出現（已知總量）",
          options.stepTimeoutMs,
        );
        const progress = await evaluate<{ text: string }>(
          win,
          `({ text: (document.querySelector("#mnemoshelf-bootstrap") || {}).innerText || "" })`,
        );
        shots.push(await shoot(win, options.outputDir, "02-bootstrap-progress.png"));
        const state = snapshotBootstrap();
        const detail = `phase=${state?.phase ?? "未知"}；已下載 ${state?.progress.loaded ?? 0}／${state?.progress.total ?? 0} bytes（${state?.progress.percent ?? 0}%）；畫面：${progress.text.replace(/\s+/g, " ").slice(0, 160)}`;
        if (options.killAfterProgress) {
          console.log(`[autotest] KILL_ME_NOW ${JSON.stringify({ loaded: state?.progress.loaded ?? 0, total: state?.progress.total ?? 0, percent: state?.progress.percent ?? 0 })}`);
          return `${detail}（中斷模擬：停在這裡等外部砍掉行程）`;
        }
        return detail;
      });
    } else if (options.killAfterProgress) {
      // 中斷模擬的前提是「模型不在磁碟上」；已就緒時直接回報，讓驅動腳本看得出來。
      console.log("[autotest] KILL_ME_NOW_SKIPPED（模型已在磁碟上，沒有東西可中斷）");
    }

    if (needsDownload && !options.killAfterProgress) {
      await run("bootstrap", "模型就緒", async () => {
        const win = requireWindow();
        const state = await waitForBootstrapPhase(["ready"], options.bootstrapTimeoutMs);
        if (state.phase !== "ready") throw new Error(`模型尚未就緒，最後狀態：${state.phase}（${state.message}）`);
        // UI 也必須離開下載畫面（模型就緒後才會出現主要介面）。
        await waitFor(win, `document.querySelector("#mnemoshelf-bootstrap") === null`, "下載畫面消失", options.stepTimeoutMs);
        shots.push(await shoot(win, options.outputDir, "03-bootstrap-ready.png"));
        const listing = await listDir(state.modelDir);
        return `下載完成；模型目錄 ${listing.files.length} 個檔案／${listing.totalBytes} bytes；沿用磁碟既有檔案 ${state.reusedBytes} bytes；清掉中斷暫存檔 ${state.removedTempFiles.length} 個`;
      });
    }
  }

  if (scenarios.includes("app")) {
    await run("app", "桌面模式不需要 token", async () => {
      const win = requireWindow();
      // 等 UI 進入主要畫面（模型就緒後才會出現）。
      await waitFor(
        win,
        `document.body.innerText.includes("已連線到本機服務")`,
        "UI 進入已連線狀態",
        options.stepTimeoutMs,
      );
      const tokens = await evaluate<{ form: boolean; text: boolean; bridge: boolean }>(
        win,
        `({
  form: document.querySelector("#mnemoshelf-token") !== null,
  text: document.body.innerText.includes("存取 token"),
  bridge: typeof window.mnemoshelfDesktop === "object" && window.mnemoshelfDesktop !== null,
})`,
      );
      shots.push(await shoot(win, options.outputDir, "04-desktop-mode.png"));
      if (!tokens.bridge) throw new Error("renderer 找不到 desktop bridge（preload 沒生效）");
      if (tokens.form || tokens.text) throw new Error("桌面模式仍出現手動貼 token 的畫面");
      return "沒有 token 表單、也沒有「存取 token」字樣；renderer 只看得到 desktop bridge（401 統計見報告的 authCounters）";
    });
  }

  if (scenarios.includes("agent-guide")) {
    /** 本輪 runtime.json 的 token：只留在記憶體，不寫進任何 detail、報告或 log。 */
    let runtimeToken: string | null = null;
    const tokenForChecks = async (): Promise<string> => {
      if (runtimeToken !== null) return runtimeToken;
      const raw = await fs.readFile(options.runtimeFile, "utf8").catch(() => null);
      if (raw === null) {
        throw new Error("找不到連線資訊檔（runtime.json）；這一輪無法驗「不含 token」，請先確認 Agent 連線資訊已開啟並重新啟動 App");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("連線資訊檔不是合法 JSON；這一輪無法驗「不含 token」");
      }
      const token =
        typeof parsed === "object" && parsed !== null ? (parsed as { token?: unknown }).token : undefined;
      if (typeof token !== "string" || token === "") {
        throw new Error("連線資訊檔沒有 token；這一輪無法驗「不含 token」");
      }
      runtimeToken = token;
      return token;
    };

    /** 剪貼簿不得含 token；錯誤訊息一律不放剪貼簿內容。 */
    const assertNoToken = (text: string, token: string): void => {
      if (text.includes(token)) throw new Error("複製內容含 token");
    };

    /** 讀某個元素的 `innerText`（不存在時回空字串）。 */
    const readElementText = async (win: BrowserWindow, selector: string): Promise<string> =>
      evaluate<string>(
        win,
        `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  return el === null ? "" : (el.innerText || "");
})()`,
      );

    /** 切到某個 tab，並等 `aria-selected` 反映這次切換。 */
    const selectAgentGuideTab = async (win: BrowserWindow, tab: string): Promise<void> => {
      const selector = `#mnemoshelf-agent-guide-tabs button[data-tab="${tab}"]`;
      const clicked = await evaluate<boolean>(win, clickSelectorExpression(selector));
      if (!clicked) throw new Error(`找不到 ${tab} tab 的按鈕`);
      await waitFor(
        win,
        `document.querySelector(${JSON.stringify(`${selector}[aria-selected="true"]`)}) !== null`,
        `切到 ${tab} tab`,
        options.stepTimeoutMs,
      );
    };

    /**
     * 等這一頁的偵測結果與預覽就緒。
     *
     * 複製片段按鈕不再 disabled 代表 `getState()` 已回來（load.kind === "ready"），
     * 這樣才不會把「正在偵測…」或「讀取中…」誤當成結果。
     */
    const waitForAgentGuideReady = async (win: BrowserWindow, tab: string): Promise<void> => {
      await waitFor(
        win,
        `(() => {
  const detection = document.querySelector("#mnemoshelf-agent-guide-detection");
  const preview = document.querySelector("#mnemoshelf-agent-guide-preview");
  const copySnippet = document.querySelector("#mnemoshelf-agent-guide-copy-snippet");
  return detection !== null && (detection.innerText || "").trim() !== ""
    && preview !== null && (preview.innerText || "").trim() !== ""
    && copySnippet !== null && copySnippet.disabled === false;
})()`,
        `${tab} tab 的偵測結果與片段預覽就緒`,
        options.stepTimeoutMs,
      );
    };

    await run("agent-guide", "進入「連接 Agent」頁面", async () => {
      const win = requireWindow();
      await waitFor(
        win,
        `document.body.innerText.includes("已連線到本機服務") && ${buttonExistsExpression("連接 Agent")}`,
        "UI 進入已連線狀態（若模型尚未下載，請先跑一次含 bootstrap 的 gui）",
        options.stepTimeoutMs,
      );
      // 前面的情境可能把設定頁打開（例如 autostart）；先關掉，截圖才不會被設定頁蓋住。
      const settingsOpen = await evaluate<boolean>(win, `document.querySelector("#mnemoshelf-settings") !== null`);
      if (settingsOpen) {
        await evaluate(win, clickByTextExpression("關閉"));
        await waitFor(
          win,
          `document.querySelector("#mnemoshelf-settings") === null`,
          "關閉設定頁",
          options.stepTimeoutMs,
        );
      }
      const clicked = await evaluate<boolean>(win, clickByTextExpression("連接 Agent"));
      if (!clicked) throw new Error("找不到導覽項目「連接 Agent」");
      await waitFor(
        win,
        `document.querySelector("#mnemoshelf-agent-guide") !== null`,
        "連接 Agent 頁面出現",
        options.stepTimeoutMs,
      );
      await waitForAgentGuideReady(win, "opencode");
      // 讓第一次繪製完成再截圖（capturePage 偶爾會拿到上一個畫面）。
      await delay(300);
      shots.push(await shoot(win, options.outputDir, "17-agent-guide-opencode.png"));
      return "已從主導覽進入「連接 Agent」，預設 OpenCode tab 的偵測結果與預覽已就緒";
    });

    await run("agent-guide", "四個 tab 都可切換、有偵測結果與片段預覽", async () => {
      const win = requireWindow();
      const tabs = ["opencode", "codex", "dsh", "other"] as const;
      for (const tab of tabs) {
        await selectAgentGuideTab(win, tab);
        await waitForAgentGuideReady(win, tab);
        const detection = (await readElementText(win, "#mnemoshelf-agent-guide-detection")).trim();
        const preview = (await readElementText(win, "#mnemoshelf-agent-guide-preview")).trim();
        if (tab === "other") {
          if (!detection.includes("不偵測")) throw new Error("other tab 的偵測行應含「不偵測」");
        } else if (!detection.includes("偵測到") && !detection.includes("無法判讀")) {
          throw new Error(`${tab} tab 的偵測行不是三態之一`);
        }
        if (preview === "") throw new Error(`${tab} tab 的片段預覽是空的`);
        await delay(250);
        shots.push(await shoot(win, options.outputDir, `18-agent-guide-${tab}.png`));
      }
      return "opencode／codex／dsh 的偵測行都是三態之一（不假設偵測到）、other 顯示「不偵測」；四個 tab 的預覽都非空並已截圖";
    });

    await run("agent-guide", "複製 OpenCode 安裝指令卡：含必要字串、不含 token", async () => {
      const win = requireWindow();
      const token = await tokenForChecks();
      await selectAgentGuideTab(win, "opencode");
      await waitForAgentGuideReady(win, "opencode");
      const clicked = await evaluate<boolean>(win, clickSelectorExpression("#mnemoshelf-agent-guide-copy-card"));
      if (!clicked) throw new Error("找不到「複製安裝指令卡」按鈕");
      await waitFor(
        win,
        `(() => {
  const notice = document.querySelector("#mnemoshelf-agent-guide-notice");
  return notice !== null && (notice.innerText || "").includes("已複製");
})()`,
        "複製安裝指令卡的成功提示出現",
        options.stepTimeoutMs,
      );
      const copied = await clipboard.readText();
      assertNoToken(copied, token);
      if (!copied.includes("<REPO_DIR>")) throw new Error("安裝指令卡缺少 <REPO_DIR>");
      if (!copied.includes("packages/opencode-plugin")) throw new Error("安裝指令卡缺少 packages/opencode-plugin");
      if (!copied.includes("runtime.json")) throw new Error("安裝指令卡缺少 runtime.json 字樣");
      return "剪貼簿含 <REPO_DIR>、packages/opencode-plugin 與 runtime.json；不含 token";
    });

    await run("agent-guide", "複製 codex 片段：含必要字串、不含 token", async () => {
      const win = requireWindow();
      const token = await tokenForChecks();
      await selectAgentGuideTab(win, "codex");
      await waitForAgentGuideReady(win, "codex");
      const clicked = await evaluate<boolean>(win, clickSelectorExpression("#mnemoshelf-agent-guide-copy-snippet"));
      if (!clicked) throw new Error("找不到「複製片段」按鈕（codex）");
      await waitFor(
        win,
        `(() => {
  const notice = document.querySelector("#mnemoshelf-agent-guide-notice");
  return notice !== null && (notice.innerText || "").includes("已複製");
})()`,
        "複製 codex 片段的成功提示出現",
        options.stepTimeoutMs,
      );
      const copied = await clipboard.readText();
      assertNoToken(copied, token);
      if (!copied.includes("[mcp_servers.mnemoshelf]")) throw new Error("codex 片段缺少 [mcp_servers.mnemoshelf]");
      if (!copied.includes("ELECTRON_RUN_AS_NODE")) throw new Error("codex 片段缺少 ELECTRON_RUN_AS_NODE");
      return "剪貼簿含 [mcp_servers.mnemoshelf] 與 ELECTRON_RUN_AS_NODE；不含 token";
    });

    await run("agent-guide", "複製 dsh 片段：含必要字串、不含 token", async () => {
      const win = requireWindow();
      const token = await tokenForChecks();
      await selectAgentGuideTab(win, "dsh");
      await waitForAgentGuideReady(win, "dsh");
      const clicked = await evaluate<boolean>(win, clickSelectorExpression("#mnemoshelf-agent-guide-copy-snippet"));
      if (!clicked) throw new Error("找不到「複製片段」按鈕（dsh）");
      await waitFor(
        win,
        `(() => {
  const notice = document.querySelector("#mnemoshelf-agent-guide-notice");
  return notice !== null && (notice.innerText || "").includes("已複製");
})()`,
        "複製 dsh 片段的成功提示出現",
        options.stepTimeoutMs,
      );
      const copied = await clipboard.readText();
      assertNoToken(copied, token);
      if (!copied.includes('"dependencies"')) throw new Error('dsh 片段缺少 "dependencies"');
      if (!copied.includes('"bundles"')) throw new Error('dsh 片段缺少 "bundles"');
      return '剪貼簿含 "dependencies" 與 "bundles"；不含 token';
    });

    await run("agent-guide", "預覽與剪貼簿內容一致（dsh）", async () => {
      const win = requireWindow();
      const copied = (await clipboard.readText()).trim();
      const preview = (await readElementText(win, "#mnemoshelf-agent-guide-preview")).trim();
      if (copied === "") throw new Error("剪貼簿是空的");
      if (copied !== preview) throw new Error("剪貼簿內容與頁面預覽不一致");
      return "剪貼簿內容與 dsh 片段預覽逐字相同";
    });

    await run("agent-guide", "重新偵測後偵測行仍非空", async () => {
      const win = requireWindow();
      const clicked = await evaluate<boolean>(win, clickSelectorExpression("#mnemoshelf-agent-guide-redetect"));
      if (!clicked) throw new Error("找不到「重新偵測」按鈕");
      // 先給 IPC 一個往返的時間，再確認畫面回到可操作且偵測行仍有內容。
      await delay(300);
      await waitFor(
        win,
        `(() => {
  const button = document.querySelector("#mnemoshelf-agent-guide-redetect");
  const detection = document.querySelector("#mnemoshelf-agent-guide-detection");
  return button !== null && button.disabled === false
    && detection !== null && (detection.innerText || "").trim() !== "";
})()`,
        "重新偵測完成且偵測行非空",
        options.stepTimeoutMs,
      );
      const detection = (await readElementText(win, "#mnemoshelf-agent-guide-detection")).trim();
      if (!detection.includes("偵測到") && !detection.includes("無法判讀") && !detection.includes("不偵測")) {
        throw new Error("重新偵測後偵測行不是三態之一");
      }
      return "重新偵測完成；偵測行仍非空（內容不寫進報告）";
    });

    await run("agent-guide", "回到「檔案總管」", async () => {
      const win = requireWindow();
      const clicked = await evaluate<boolean>(win, clickByTextExpression("檔案總管"));
      if (!clicked) throw new Error("找不到導覽項目「檔案總管」");
      await waitFor(
        win,
        `document.querySelector("#mnemoshelf-agent-guide") === null && ${buttonExistsExpression("加入")}`,
        "回到檔案總管",
        options.stepTimeoutMs,
      );
      return "已回到「檔案總管」，不影響後續 single／browser／index 情境";
    });
  }

  if (scenarios.includes("single")) {
    await run("single", "第二個實例把既有視窗帶到前景後結束", async () => {
      const win = requireWindow();
      options.showMainWindow("驗收：先確認視窗存在");
      win.hide();
      await delay(400);
      if (win.isVisible()) throw new Error("前置條件失敗：視窗應該先隱藏");
      const result = await options.spawnSecondInstance();
      if (result.code !== 0) {
        throw new Error(`第二個實例的退出碼是 ${result.code}（signal=${result.signal}）：應該在取得鎖失敗後直接結束`);
      }
      const startedAt = Date.now();
      while (!win.isVisible() && Date.now() - startedAt < 15_000) await delay(200);
      if (!win.isVisible()) throw new Error("既有視窗沒有被帶到前景（second-instance 沒有生效）");
      shots.push(await shoot(win, options.outputDir, "04b-second-instance.png"));
      return "第二個實例直接結束（退出碼 0）；既有視窗被帶到前景";
    });
  }

  if (scenarios.includes("browser")) {
    await run("browser", "瀏覽器模式（沒有 desktop bridge）仍走手動貼 token", async () => {
      // 另開一個「沒有 preload」的視窗模擬直接在瀏覽器開服務網址：這條路徑不能因為桌面殼而壞掉。
      const browserWindow = new BrowserWindow({ show: false, width: 1200, height: 800 });
      try {
        await browserWindow.loadURL(options.serverUrl);
        await waitFor(browserWindow, `document.querySelector("#mnemoshelf-token") !== null`, "token 輸入畫面出現", options.stepTimeoutMs);
        const bridge = await evaluate<boolean>(
          browserWindow,
          `typeof window.mnemoshelfDesktop === "object" && window.mnemoshelfDesktop !== null`,
        );
        if (bridge) throw new Error("這個視窗不該有 desktop bridge");
        shots.push(await shoot(browserWindow, options.outputDir, "04c-browser-mode-token-form.png"));
        if (options.browserToken === null) {
          return "沒有 preload 的視窗出現手動貼 token 的畫面（未貼 token，跳過連線驗證）";
        }
        await evaluate(browserWindow, setInputExpression("#mnemoshelf-token", options.browserToken));
        await evaluate(browserWindow, clickByTextExpression("連線"));
        await waitFor(
          browserWindow,
          `document.body.innerText.includes("已連線到本機服務")`,
          "貼上 token 後連線成功",
          options.stepTimeoutMs,
        );
        shots.push(await shoot(browserWindow, options.outputDir, "04d-browser-mode-connected.png"));
        return "沒有 preload 的視窗顯示 token 表單；貼上 token 後成功連線（瀏覽器模式未被桌面殼改壞）";
      } finally {
        if (!browserWindow.isDestroyed()) browserWindow.destroy();
      }
    });
  }

  if (scenarios.includes("index") && options.sampleRoot.trim() !== "") {
    await run("index", "加入測試資料夾", async () => {
      const win = requireWindow();
      // 這一輪的基準：模型檔案清單（跑完索引後要比對，確認預先下載的檔案就是 embedder 要用的）。
      modelDirListingBeforeIndex = await listDir(options.modelDir);
      await evaluate(win, clickByTextExpression("加入"));
      await waitFor(win, `document.querySelector("#add-root-path") !== null`, "加入資料夾表單出現", options.stepTimeoutMs);
      await evaluate(win, setInputExpression("#add-root-path", options.sampleRoot));
      shots.push(await shoot(win, options.outputDir, "05-add-root-form.png"));
      await evaluate(win, clickByTextExpression("加入並預覽"));
      await waitFor(
        win,
        `(${buttonExistsExpression("開始索引")}) || (${ACTIVE_ALERT_EXPRESSION}) !== null`,
        "預覽統計出現",
        options.stepTimeoutMs,
      );
      const addError = await evaluate<string | null>(win, ACTIVE_ALERT_EXPRESSION);
      if (addError !== null) throw new Error(`加入資料夾失敗：${addError}`);
      const preview = await evaluate<{ text: string }>(
        win,
        `(() => {
  const start = document.body.innerText.indexOf("加入資料夾");
  return { text: document.body.innerText.slice(start, start + 700) };
})()`,
      );
      shots.push(await shoot(win, options.outputDir, "06-preview.png"));
      previewText = preview.text;
      return "已加入並取得預覽統計（詳見報告 previewText）";
    });

    await run("index", "建立索引", async () => {
      const win = requireWindow();
      await evaluate(win, clickByTextExpression("開始索引"));
      const indexDoneExpression = `document.body.innerText.includes("索引完成")`;
      await waitFor(
        win,
        `(${indexDoneExpression}) || ((${ACTIVE_ALERT_EXPRESSION}) !== null)`,
        "索引完成",
        options.indexTimeoutMs,
      );
      const indexError = await evaluate<string | null>(win, ACTIVE_ALERT_EXPRESSION);
      if (indexError !== null && !indexError.includes("索引完成")) {
        throw new Error(`索引失敗（UI 顯示的錯誤訊息）：${indexError}`);
      }
      shots.push(await shoot(win, options.outputDir, "07-indexed.png"));
      const status = await evaluate<{ text: string }>(win, `({ text: document.body.innerText })`);
      const line = status.text.split("\n").find((item) => item.includes("索引完成")) ?? "索引完成";
      return line;
    });

    await run("index", "模型檔案清單沒有變動", async () => {
      const after = await listDir(options.modelDir);
      const before = modelDirListingBeforeIndex as { files: { relPath: string; bytes: number }[] } | null;
      if (before === null) throw new Error("沒有索引前的模型清單可比對");
      const beforeNames = before.files.map((file) => file.relPath).sort();
      const afterNames = after.files.map((file) => file.relPath).sort();
      const added = afterNames.filter((name) => !beforeNames.includes(name));
      if (added.length > 0) {
        throw new Error(`索引後多出檔案（預先下載的集合與 embedder 要用的不一致）：${added.join("、")}`);
      }
      return `索引前後都是 ${afterNames.length} 個檔案（預先下載的集合與 embedder 實際載入的一致）`;
    });

    await run("index", "文字檔預覽", async () => {
      const win = requireWindow();
      await waitFor(
        win,
        `document.querySelector('[title=${JSON.stringify(options.sampleTextName)}]') !== null`,
        `目錄樹出現 ${options.sampleTextName}`,
        options.stepTimeoutMs,
      );
      await evaluate(win, clickSelectorExpression(`[title=${JSON.stringify(options.sampleTextName)}]`));
      await waitFor(win, `document.querySelector("pre") !== null`, "文字預覽出現", options.stepTimeoutMs);
      shots.push(await shoot(win, options.outputDir, "08-text-preview.png"));
      const info = await evaluate<{ textHead: string; textLength: number }>(win, elementInfoExpression("pre"));
      return `pre 內容 ${info.textLength} 字，開頭：${info.textHead.replace(/\n/g, " ").slice(0, 60)}`;
    });

    await run("index", "搜尋命中", async () => {
      const win = requireWindow();
      await evaluate(win, clickByTextExpression("搜尋"));
      await waitFor(win, `document.querySelector("#mnemoshelf-search-query") !== null`, "搜尋畫面出現", options.stepTimeoutMs);
      await evaluate(win, setInputExpression("#mnemoshelf-search-query", options.searchQuery));
      await evaluate(win, clickSelectorExpression('form button[type="submit"]'));
      await waitFor(
        win,
        `(() => { const m = document.body.innerText.match(/共 (\\d+) 筆結果/); return m !== null && Number(m[1]) > 0; })()`,
        "搜尋結果出現",
        options.stepTimeoutMs,
      );
      shots.push(await shoot(win, options.outputDir, "09-search-hits.png"));
      const hit = await evaluate<{ count: number; hasSample: boolean }>(
        win,
        `(() => {
  const text = document.body.innerText;
  const m = text.match(/共 (\\d+) 筆結果/);
  return { count: m === null ? 0 : Number(m[1]), hasSample: text.includes(${JSON.stringify(options.sampleTextName)}) };
})()`,
      );
      if (!hit.hasSample) throw new Error(`搜尋結果沒有命中樣本檔 ${options.sampleTextName}`);
      return `共 ${hit.count} 筆結果，含 ${options.sampleTextName}`;
    });
  }

  if (scenarios.includes("autostart")) {
    await run("autostart", "開啟開機自啟", async () => {
      const win = requireWindow();
      await evaluate(win, clickByTextExpression("設定"));
      await waitFor(win, `document.querySelector("#mnemoshelf-autostart") !== null`, "設定畫面出現", options.stepTimeoutMs);
      const before = await evaluate<{ checked: boolean }>(win, `({ checked: document.querySelector("#mnemoshelf-autostart").checked })`);
      if (before.checked) throw new Error("開機自啟的預設狀態應該是關閉的");
      shots.push(await shoot(win, options.outputDir, "10-settings.png"));
      await evaluate(win, clickSelectorExpression("#mnemoshelf-autostart"));
      await waitFor(win, `document.querySelector("#mnemoshelf-autostart").checked === true`, "開關切成開啟", options.stepTimeoutMs);
      await waitFor(win, `!document.querySelector("#mnemoshelf-autostart").disabled`, "設定完成", options.stepTimeoutMs);
      shots.push(await shoot(win, options.outputDir, "11-autostart-on.png"));
      const state = await evaluate<{ detail: string }>(win, `({ detail: (document.querySelector("#mnemoshelf-autostart-detail") || {}).innerText || "" })`);
      const file = options.autostartFile;
      if (file === null) throw new Error("這個平台沒有 autostart 檔可檢查");
      const content = await fs.readFile(file, "utf8").catch(() => null);
      if (content === null) throw new Error(`開啟後沒有寫出 ${file}`);
      if (!content.includes("--hidden")) throw new Error("autostart 檔的 Exec 沒有帶 --hidden");
      return `開關已開啟、落地檔已寫出（${file}）；UI 說明：${state.detail.replace(/\s+/g, " ")}`;
    });

    await run("autostart", "關閉開機自啟", async () => {
      const win = requireWindow();
      await evaluate(win, clickSelectorExpression("#mnemoshelf-autostart"));
      await waitFor(win, `document.querySelector("#mnemoshelf-autostart").checked === false`, "開關切成關閉", options.stepTimeoutMs);
      await waitFor(win, `!document.querySelector("#mnemoshelf-autostart").disabled`, "設定完成", options.stepTimeoutMs);
      shots.push(await shoot(win, options.outputDir, "12-autostart-off.png"));
      const file = options.autostartFile;
      if (file === null) throw new Error("這個平台沒有 autostart 檔可檢查");
      const stillThere = await fs.stat(file).then(() => true).catch(() => false);
      if (stillThere) throw new Error(`關閉後 ${file} 仍然存在`);
      return `開關已關閉；${file} 已刪除`;
    });
  }

  if (scenarios.includes("agent")) {
    await run("agent", "Agent 連線資訊：預設開啟、狀態可用、複製含 token", async () => {
      const win = requireWindow();
      // 先等主畫面出現（UI 還在「正在連線」時按「設定」會按不到）。
      await waitFor(
        win,
        `document.body.innerText.includes("已連線到本機服務") && ${buttonExistsExpression("設定")}`,
        "UI 進入已連線狀態",
        options.stepTimeoutMs,
      );
      // 前面的情境可能已把設定頁打開；不要重複點「設定」把它關掉。
      const panelOpen = await evaluate<boolean>(win, `document.querySelector("#mnemoshelf-settings") !== null`);
      if (!panelOpen) await evaluate(win, clickByTextExpression("設定"));
      await waitFor(
        win,
        `document.querySelector("#mnemoshelf-agent-discovery") !== null`,
        "設定頁出現 Agent 連線資訊區塊",
        options.stepTimeoutMs,
      );

      const initial = await evaluate<{ checked: boolean; disabled: boolean; status: string }>(
        win,
        `(() => {
  const toggle = document.querySelector("#mnemoshelf-agent-discovery");
  const status = document.querySelector("#mnemoshelf-agent-discovery-status");
  return { checked: toggle.checked, disabled: toggle.disabled, status: status ? status.innerText : "" };
})()`,
      );
      if (!initial.checked) throw new Error("Agent 連線資訊的預設狀態應該是開啟");
      if (initial.disabled) throw new Error("Agent 連線資訊開關不該在初始狀態被停用");
      const status = initial.status.replace(/\s+/g, " ");
      if (!status.includes("可用")) throw new Error(`狀態列沒有顯示「可用」：${status}`);
      if (!status.includes(options.runtimeFile)) throw new Error("狀態列沒有顯示連線資訊檔路徑");

      const raw = await fs.readFile(options.runtimeFile, "utf8").catch(() => null);
      if (raw === null) throw new Error(`預設開啟時沒有寫出 ${options.runtimeFile}`);
      const record = JSON.parse(raw) as { url?: unknown; token?: unknown };
      if (record.url !== options.serverUrl) throw new Error("runtime 檔的 url 與目前服務不一致");
      // 讓設定頁完成第一次繪製再截圖（capturePage 偶爾會拿到上一個畫面）。
      await delay(300);
      shots.push(await shoot(win, options.outputDir, "13-agent-discovery-on.png"));

      // 「複製連線資訊」→ 剪貼簿必須含目前的 url 與 token；token 不寫進報告或 log。
      await evaluate(win, clickSelectorExpression("#mnemoshelf-agent-copy"));
      await waitFor(win, `document.body.innerText.includes("已複製")`, "複製成功提示出現", options.stepTimeoutMs);
      let copied: { url?: unknown; token?: unknown } | null = null;
      try {
        copied = JSON.parse(await clipboard.readText()) as { url?: unknown; token?: unknown };
      } catch {
        throw new Error("剪貼簿內容不是合法的 JSON");
      }
      if (copied === null || copied.url !== options.serverUrl) throw new Error("剪貼簿的 url 與目前服務不一致");
      if (options.browserToken === null || copied.token !== options.browserToken) {
        throw new Error("剪貼簿的 token 與目前服務不一致");
      }
      shots.push(await shoot(win, options.outputDir, "14-agent-discovery-copied.png"));

      // 關閉 → 立即刪檔（即使 server 還在同一行程裡跑）。
      await evaluate(win, clickSelectorExpression("#mnemoshelf-agent-discovery"));
      await waitFor(win, `document.querySelector("#mnemoshelf-agent-discovery").checked === false`, "開關切成關閉", options.stepTimeoutMs);
      await waitFor(win, `!document.querySelector("#mnemoshelf-agent-discovery").disabled`, "設定完成", options.stepTimeoutMs);
      const afterOff = await fs.stat(options.runtimeFile).then(() => true).catch(() => false);
      if (afterOff) throw new Error("關閉連線資訊後 runtime 檔仍然存在");
      shots.push(await shoot(win, options.outputDir, "15-agent-discovery-off.png"));

      // 重新開啟 → 這次執行不會補寫（要重啟 server），但設定已持久化。
      await evaluate(win, clickSelectorExpression("#mnemoshelf-agent-discovery"));
      await waitFor(win, `document.querySelector("#mnemoshelf-agent-discovery").checked === true`, "開關切成開啟", options.stepTimeoutMs);
      await waitFor(win, `!document.querySelector("#mnemoshelf-agent-discovery").disabled`, "設定完成", options.stepTimeoutMs);
      const afterOn = await fs.stat(options.runtimeFile).then(() => true).catch(() => false);
      if (afterOn) throw new Error("重新開啟後不該在未重啟 server 時寫出 runtime 檔");
      shots.push(await shoot(win, options.outputDir, "16-agent-discovery-reenabled.png"));

      // 收尾：關掉設定頁，避免影響後續情境（tray）。
      await evaluate(win, clickByTextExpression("關閉"));
      return "預設開啟且狀態顯示可用；複製內容含 url 與 token（未寫入報告）；關閉後檔案立即刪除；重新開啟需重啟才寫出";
    });
  }

  if (scenarios.includes("hidden")) {
    await run("hidden", "以 --hidden 啟動時視窗不顯示", async () => {
      const win = requireWindow();
      if (!options.startHidden) {
        // 情境前提不成立就當失敗，不能靜靜通過（否則回歸會藏在這一步後面）。
        throw new Error("這個情境要以 --hidden 啟動才會成立（啟動命令要帶 --hidden）");
      }
      // 等「顯示」的那兩條路徑都走過（ready-to-show ＋ loadURL 之後）再斷言，
      // 否則可能只是還沒走到顯示那一步而誤判成通過。
      await waitForPromise(options.windowReadyToShow, options.stepTimeoutMs, "主視窗第一次 ready-to-show");
      if (win.isDestroyed()) throw new Error("主視窗被銷毀：--hidden 只該「不顯示」，不該關掉視窗");
      if (win.isVisible()) {
        throw new Error("以 --hidden 啟動後主視窗仍然可見：顯示路徑沒有守住 startHidden（開機自啟會彈出視窗）");
      }
      const url = win.webContents.getURL();
      if (!url.startsWith(options.serverUrl)) {
        throw new Error(`主視窗沒有載入本機服務的 UI（目前網址：${url}）`);
      }
      return `視窗已建立、UI 已載入、第一次 ready-to-show 已發生，但視窗仍不可見（${url}）`;
    });
  }

  if (scenarios.includes("tray")) {
    await run("tray", "關窗縮到系統匣", async () => {
      const win = requireWindow();
      shots.push(await shoot(win, options.outputDir, "13-before-close.png"));
      options.showMainWindow("驗收：先確認視窗可以顯示");
      win.close();
      await delay(500);
      if (win.isDestroyed()) throw new Error("視窗被銷毀：應該只是隱藏");
      if (win.isVisible()) throw new Error("視窗仍然可見：關窗沒有縮到系統匣");
      if (options.tray === null || options.tray.isDestroyed()) throw new Error("系統匣圖示不存在");
      const labels = options.trayMenuItems.join("／");
      return `視窗已隱藏、程序存活、系統匣圖示存在（選單項目：${labels}）`;
    });

    await run("tray", "系統匣「離開」結束應用程式", async () => {
      options.showMainWindow("驗收：離開前把視窗叫回來");
      await delay(200);
      // 真正的「離開」在報告寫完之後才呼叫（否則報告還沒落地行程就結束了）；
      // 呼叫的是產品程式碼裡系統匣選單綁的同一個函式。
      trayQuitRequested = true;
      return "已準備從系統匣選單結束（報告寫出後立即呼叫 exitFromTray；結束與退出碼由驅動腳本確認）";
    });
  }

  const modelListing = await listDir(options.modelDir);
  const rendererMessages = [...(options.rendererMessages ?? [])];
  const glibMessages = rendererMessages.filter((message) => /glib/i.test(message));
  const finalBootstrap = snapshotBootstrap();
  const report = {
    ok: failure === null,
    failure,
    scenarios,
    environment: options.environment ?? {},
    steps,
    // 跳過截圖或截圖失敗時 shoot() 回傳空字串，報告只列真正寫出的檔案。
    screenshots: shots.filter((file) => file !== ""),
    previewText,
    bootstrapFinal: finalBootstrap,
    bootstrapHistory,
    modelDirListing: modelListing,
    rendererMessages,
    glibMessages,
    generatedAt: new Date().toISOString(),
  };
  const reportPath = path.join(options.outputDir, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[autotest] 報告已寫出：${reportPath}`);

  if (trayQuitRequested && failure === null) {
    // 報告寫完才真的走「系統匣 → 離開」：驗的是產品程式碼那條結束路徑。
    console.log("[autotest] 呼叫系統匣選單的「離開」");
    options.exitFromTray();
    return { ok: true, failure, steps, reportPath, exitCode: null };
  }

  // 中斷模擬要停在原地等外部砍掉行程。
  if (failure !== null) exitCode = 1;
  if (options.killAfterProgress) exitCode = null;

  return { ok: failure === null, failure, steps, reportPath, exitCode };
}
