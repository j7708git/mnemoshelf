/**
 * Spike 自動驗收：用一個真實視窗把「貼 token → 加入資料夾 → 索引 → 搜尋 → 預覽縮圖」跑一遍，
 * 每一步截圖並寫出 `report.json`。
 *
 * 只在設了環境變數 `MNEMOSHELF_SPIKE_AUTOTEST` 時啟用（正常啟動不會載入本模組），
 * 由 `scripts/smoke.mjs` 驅動。**這不是產品功能**，是 spike 的可驗證性工具：
 * 操作的是真正的 UI（在 renderer 內以 DOM 事件驅動），不是繞過 UI 直接打 API。
 */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";

/** 單一步驟的結果。 */
export interface SpikeStepResult {
  name: string;
  ok: boolean;
  detail: string;
  at: string;
}

/** 自動驗收的輸入。 */
export interface SpikeAutotestOptions {
  window: BrowserWindow;
  /** 待貼進 UI 的 token（由 harness 從 userData 的 token 檔讀出，模擬使用者手動貼上）。 */
  token: string;
  /** 要加入的測試資料夾（含 .txt 與 .png）。 */
  sampleRoot: string;
  /** 樣本文字檔名（目錄樹中要點開的文字檔）。 */
  sampleTextName: string;
  /** 樣本圖片檔名（用來等縮圖載入）。 */
  sampleImageName: string;
  /** 搜尋字串（預期命中樣本檔）。 */
  searchQuery: string;
  /** 產物目錄。 */
  outputDir: string;
  /** 一般步驟的等待上限。 */
  stepTimeoutMs: number;
  /** 索引步驟的等待上限（首次會下載模型，改用較寬鬆的上限）。 */
  indexTimeoutMs: number;
  /** 模型快取目錄（報告裡列出落地檔案，驗證模型不在 asar 內）。 */
  modelDir: string;
  /** 啟動環境的事實（版本、路徑、原生模組探測…），一併寫進報告。 */
  environment?: Record<string, unknown>;
  /** renderer 的 console 訊息（含 sharp 之類原生模組的警告）。 */
  rendererMessages?: readonly string[];
}

/** 自動驗收的輸出。 */
export interface SpikeAutotestResult {
  ok: boolean;
  failure: string | null;
  steps: SpikeStepResult[];
  reportPath: string;
}

const POLL_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      console.log(`[spike-autotest] 仍在等待：${description}（已等 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
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
    textHead: (el.textContent || "").slice(0, 120),
  };
})()`;
}

async function shoot(window: BrowserWindow, outputDir: string, name: string): Promise<string> {
  const image = await window.webContents.capturePage();
  const file = path.join(outputDir, name);
  await fs.writeFile(file, image.toPNG());
  return file;
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

/** 跑完整套自動驗收；不論成敗都寫出報告，最後以例外回報失敗原因。 */
export async function runSpikeAutotest(options: SpikeAutotestOptions): Promise<SpikeAutotestResult> {
  await fs.mkdir(options.outputDir, { recursive: true });
  const steps: SpikeStepResult[] = [];
  const shots: string[] = [];
  let failure: string | null = null;
  let previewText = "";

  const record = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail, at: new Date().toISOString() });
    console.log(`[spike-autotest] ${ok ? "✓" : "✗"} ${name}：${detail}`);
  };

  const run = async (name: string, body: () => Promise<string>): Promise<void> => {
    if (failure !== null) return;
    try {
      const detail = await body();
      record(name, true, detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record(name, false, message);
      failure = `${name}：${message}`;
      await shoot(options.window, options.outputDir, `99-失敗-${name}.png`).catch(() => undefined);
    }
  };

  const window = options.window;

  await run("貼上 token", async () => {
    await waitFor(window, `document.querySelector("#mnemoshelf-token") !== null`, "token 輸入畫面出現", options.stepTimeoutMs);
    shots.push(await shoot(window, options.outputDir, "01-token-form.png"));
    await evaluate(window, setInputExpression("#mnemoshelf-token", options.token));
    await evaluate(window, clickByTextExpression("連線"));
    await waitFor(
      window,
      `document.body.innerText.includes("已連線到本機服務")`,
      "連上本機服務（token 通過驗證）",
      options.stepTimeoutMs,
    );
    shots.push(await shoot(window, options.outputDir, "02-connected.png"));
    return "token 由 userData 的 token 檔讀出後貼進 UI，服務回 200（清單載入成功）";
  });

  await run("加入測試資料夾", async () => {
    await evaluate(window, clickByTextExpression("加入"));
    await waitFor(window, `document.querySelector("#add-root-path") !== null`, "加入資料夾表單出現", options.stepTimeoutMs);
    await evaluate(window, setInputExpression("#add-root-path", options.sampleRoot));
    shots.push(await shoot(window, options.outputDir, "03-add-root-form.png"));
    await evaluate(window, clickByTextExpression("加入並預覽"));
    // 等到預覽出現（有「開始索引」按鈕）或表單報錯（例如這個 userData 已經加入過同一條路徑）。
    await waitFor(
      window,
      `(${buttonExistsExpression("開始索引")}) || (${ACTIVE_ALERT_EXPRESSION}) !== null`,
      "預覽統計出現",
      options.stepTimeoutMs,
    );
    const addError = await evaluate<string | null>(window, ACTIVE_ALERT_EXPRESSION);
    if (addError !== null) throw new Error(`加入資料夾失敗：${addError}`);
    const preview = await evaluate<{ text: string }>(
      window,
      `(() => {
  const start = document.body.innerText.indexOf("加入資料夾");
  return { text: document.body.innerText.slice(start, start + 700) };
})()`,
    );
    shots.push(await shoot(window, options.outputDir, "04-preview.png"));
    previewText = preview.text;
    return "已加入並取得預覽統計（詳見報告 previewText）";
  });

  await run("建立索引（含首次下載模型）", async () => {
    await evaluate(window, clickByTextExpression("開始索引"));
    // ExplorerPanel 的狀態文字在完成後是「索引完成：處理 N 個…」；失敗時 AddRootFlow 會顯示
    // 「索引失敗：…」的 alert（例如模型下載失敗），兩種都要能被偵測到。
    const indexDoneExpression = `document.body.innerText.includes("索引完成")`;
    await waitFor(
      window,
      `(${indexDoneExpression}) || ((${ACTIVE_ALERT_EXPRESSION}) !== null)`,
      "索引完成",
      options.indexTimeoutMs,
    );
    const indexError = await evaluate<string | null>(window, ACTIVE_ALERT_EXPRESSION);
    if (indexError !== null && !indexError.includes("索引完成")) {
      throw new Error(`索引失敗（UI 顯示的錯誤訊息）：${indexError}`);
    }
    shots.push(await shoot(window, options.outputDir, "05-indexed.png"));
    const status = await evaluate<{ text: string }>(window, `({ text: document.body.innerText })`);
    const line = status.text.split("\n").find((item) => item.includes("索引完成")) ?? "索引完成";
    return line;
  });

  await run("文字檔預覽", async () => {
    await waitFor(
      window,
      `document.querySelector('[title=${JSON.stringify(options.sampleTextName)}]') !== null`,
      `目錄樹出現 ${options.sampleTextName}`,
      options.stepTimeoutMs,
    );
    await evaluate(window, clickSelectorExpression(`[title=${JSON.stringify(options.sampleTextName)}]`));
    await waitFor(window, `document.querySelector("pre") !== null`, "文字預覽出現", options.stepTimeoutMs);
    shots.push(await shoot(window, options.outputDir, "06-text-preview.png"));
    const info = await evaluate<{ textHead: string; textLength: number }>(window, elementInfoExpression("pre"));
    return `pre 內容 ${info.textLength} 字，開頭：${info.textHead.replace(/\n/g, " ").slice(0, 60)}`;
  });

  await run("圖片縮圖", async () => {
    await waitFor(
      window,
      `document.querySelector('[title=${JSON.stringify(options.sampleImageName)}]') !== null`,
      `目錄樹出現 ${options.sampleImageName}`,
      options.stepTimeoutMs,
    );
    await evaluate(window, clickSelectorExpression(`[title=${JSON.stringify(options.sampleImageName)}]`));
    await waitFor(
      window,
      `(() => { const img = document.querySelector('img[alt="${options.sampleImageName}"]'); return img !== null && img.complete && img.naturalWidth > 0; })()`,
      "縮圖載入完成",
      options.stepTimeoutMs,
    );
    shots.push(await shoot(window, options.outputDir, "07-image-thumbnail.png"));
    const info = await evaluate<{ naturalWidth: number; naturalHeight: number }>(
      window,
      elementInfoExpression(`img[alt="${options.sampleImageName}"]`),
    );
    return `由 /roots/:id/thumb 取得縮圖，naturalWidth=${info.naturalWidth} naturalHeight=${info.naturalHeight}`;
  });

  await run("搜尋命中", async () => {
    await evaluate(window, clickByTextExpression("搜尋"));
    await waitFor(window, `document.querySelector("#mnemoshelf-search-query") !== null`, "搜尋畫面出現", options.stepTimeoutMs);
    await evaluate(window, setInputExpression("#mnemoshelf-search-query", options.searchQuery));
    await evaluate(window, clickSelectorExpression('form button[type="submit"]'));
    await waitFor(
      window,
      `(() => { const m = document.body.innerText.match(/共 (\\d+) 筆結果/); return m !== null && Number(m[1]) > 0; })()`,
      "搜尋結果出現",
      options.stepTimeoutMs,
    );
    shots.push(await shoot(window, options.outputDir, "08-search-hits.png"));
    const hit = await evaluate<{ count: number; hasSample: boolean; text: string }>(
      window,
      `(() => {
  const text = document.body.innerText;
  const m = text.match(/共 (\\d+) 筆結果/);
  return { count: m === null ? 0 : Number(m[1]), hasSample: text.includes(${JSON.stringify(options.sampleTextName)}), text };
})()`,
    );
    if (!hit.hasSample) throw new Error(`搜尋結果沒有命中樣本檔 ${options.sampleTextName}`);
    return `共 ${hit.count} 筆結果，含 ${options.sampleTextName}`;
  });

  await run("搜尋結果預覽", async () => {
    await evaluate(
      window,
      `(() => {
  const button = [...document.querySelectorAll("ul button")].find((node) => (node.textContent || "").includes("檔案・"));
  if (!button) return false;
  button.click();
  return true;
})()`,
    );
    await waitFor(
      window,
      `document.querySelector("pre") !== null || document.querySelector("img") !== null`,
      "搜尋結果預覽出現",
      options.stepTimeoutMs,
    );
    shots.push(await shoot(window, options.outputDir, "09-search-preview.png"));
    return "點擊搜尋結果可在右側預覽";
  });

  const modelListing = await listDir(options.modelDir);
  const rendererMessages = [...(options.rendererMessages ?? [])];
  const glibMessages = rendererMessages.filter((message) => /glib/i.test(message));
  const report = {
    ok: failure === null,
    failure,
    environment: options.environment ?? {},
    steps,
    screenshots: shots,
    previewText,
    modelDir: options.modelDir,
    modelDirListing: modelListing,
    rendererMessages,
    glibMessages,
    generatedAt: new Date().toISOString(),
  };
  const reportPath = path.join(options.outputDir, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  return { ok: failure === null, failure, steps, reportPath };
}
