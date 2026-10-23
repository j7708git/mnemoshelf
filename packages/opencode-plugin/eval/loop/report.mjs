/**
 * 報告輸出（JSON＋Markdown）與結論指紋。
 *
 * 隱私邊界：
 * - 報告只放場景結果、次數與原因碼，**不放對話全文、prompt、金鑰、sessionID 明文**。
 * - 任何錯誤訊息在落地前都會把家目錄與暫存根目錄換成佔位字串。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 九條斷言的標題（報告用）。 */
export const ASSERTIONS = [
  { id: 1, title: "非跳過回合 100% 寫入回合卡（agent／kind／force／scope 正確）" },
  { id: 2, title: "召回注入最新 3 筆回合卡（舊→新、無重複；招呼語不注入）" },
  { id: 3, title: "舊回合靠語意搜尋找回（真 embedder；僅報告、不設門檻）" },
  { id: 4, title: "scope 隔離（alpha／beta／global chat）" },
  { id: 5, title: "召回去重 TTL 8 輪（fact 不重注；decision／pitfall 可重注）" },
  { id: 6, title: "fail-open（搜尋 503／逾時仍注入回合卡並記 degraded）" },
  { id: 7, title: "模型逾時（寫入前）→ 0 寫入" },
  { id: 8, title: "冪等（成功／空結果只跑一次；失敗重送會再呼叫模型）" },
  { id: 9, title: "digest.log 只含 hash／reason／count（只掃檔案）" },
];

/** 把家目錄、暫存根目錄與常見絕對路徑換成佔位字串。 */
export function makeSanitizer({ home = os.homedir(), roots = [] } = {}) {
  const sorted = [home, ...roots].filter((value) => typeof value === "string" && value !== "").sort((a, b) => b.length - a.length);
  return (value) => {
    if (value === undefined || value === null) return value;
    let text = String(value);
    for (const root of sorted) {
      while (text.includes(root)) text = text.split(root).join(root === home ? "~" : "<tmp>");
    }
    text = text.replace(/\/(?:home|Users)\/[^/\s"'`]+/g, (match) => (match.startsWith("/Users") ? "/Users/<user>" : "/home/<user>"));
    text = text.replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "C:\\Users\\<user>");
    return text;
  };
}

export function gitInfo(repoRoot) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const short = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    const dirtyFiles = status.split("\n").filter((line) => line.trim() !== "");
    return { head, short, dirty: dirtyFiles.length > 0, dirtyFileCount: dirtyFiles.length };
  } catch {
    return { head: null, short: null, dirty: null, dirtyFileCount: null };
  }
}

/**
 * 逐場景狀態的穩定指紋。
 *
 * `mode` 一併納入：同一模式重跑可比對是否一致，不同故障模式也不會撞同一個指紋。
 */
export function resultsFingerprint(cases, mode = "none") {
  const body = cases
    .map((entry) => `${entry.id}:${entry.status}`)
    .sort()
    .join("|");
  return createHash("sha256").update(`${mode}|${body}`).digest("hex").slice(0, 16);
}

function statusLabel(status) {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  if (status === "info") return "INFO";
  return "NOT RUN";
}

/**
 * 報告欄位用的安全序列化：一般物件走 JSON，其餘維持 `String()` 的既有呈現。
 *
 * `renderChecks()` 與 `printCaseResult()` 過去直接 `String()`，物件會被印成
 * `[object Object]`。這裡只改「物件」的呈現，基本型別與陣列（仍是 `a,b,c`）保持不變，
 * 既有報告文字不會大改；陣列內含物件時，元素各自走同一套序列化。
 */
export function formatReportValue(value) {
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    // 陣列維持既有的逗號接法（與 String(array) 相同），但元素若是物件要各自序列化，
    // 否則 String(array) 會印出 [object Object]。
    return value
      .map((item) => (item === null || item === undefined ? "" : formatReportValue(item)))
      .join(",");
  }
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : String(value);
  } catch {
    return String(value);
  }
}

/** 表格儲存格：null／undefined 仍舊留空（沿用舊行為）。 */
function formatCheckCell(value) {
  if (value === null || value === undefined) return "";
  return formatReportValue(value);
}

function renderChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return "";
  const rows = checks.map((entry) => {
    const name = String(entry.name).replace(/\|/g, "\\|");
    const expected = formatCheckCell(entry.expected).replace(/\|/g, "\\|");
    const actual = formatCheckCell(entry.actual).replace(/\|/g, "\\|");
    return `| ${entry.ok === false ? "✗" : "✓"} | ${name} | ${expected} | ${actual} |`;
  });
  return ["| 檢查 | 項目 | 預期 | 實際 |", "|---|---|---|---|", ...rows].join("\n");
}

function assertionStatus(report, assertionId) {
  const related = report.cases.filter((entry) => entry.assertion === assertionId);
  if (related.length === 0) return "not-run";
  if (related.some((entry) => entry.status === "fail")) return "fail";
  if (related.every((entry) => entry.status === "info")) return "info";
  if (related.every((entry) => entry.status === "pass")) return "pass";
  return "not-run";
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("# 對話記憶 L2：假宿主迴圈 harness 報告");
  lines.push("");
  lines.push(`- 產生時間：${report.generatedAt}`);
  lines.push(`- 總耗時：${(report.durationMs / 1000).toFixed(1)} 秒`);
  lines.push(
    `- git HEAD：\`${report.git.short ?? "?"}\`${report.git.dirty === true ? `（dirty：${report.git.dirtyFileCount} 個檔案）` : report.git.dirty === false ? "（clean）" : "（讀不到）"}`,
  );
  lines.push(`- 負向對照模式：\`${report.fault}\``);
  lines.push(`- 結論指紋：\`${report.fingerprint}\`（含模式）`);
  lines.push(
    `- dist 重建：${report.build?.rebuilt === true ? `是（${report.build.reason ?? "dist 過期"}）` : "否（dist 比 src 新）"}`,
  );
  lines.push("");
  lines.push("## 環境");
  lines.push("");
  lines.push(`- Node：${report.environment.node}（${report.environment.platform}）`);
  lines.push(`- embedder：${report.embedder.id ?? "?"}（${report.embedder.dimension ?? "?"} 維）`);
  lines.push(
    `- 資料目錄：暫存（不碰使用者預設資料目錄）；server 就緒閘門：${report.readiness.gate}` +
      `${report.readiness.final === null ? "" : `（pending=${report.readiness.final.pending} failed=${report.readiness.final.failed} stale=${report.readiness.final.stale}）`}`,
  );
  lines.push("");
  lines.push("## 模型驗證（`ctx.model.list`）");
  lines.push("");
  lines.push("| 實例 | 有呼叫 | 命中 digestModel | 呼叫次數 |");
  lines.push("|---|---|---|---|");
  for (const entry of report.modelValidation.instances) {
    lines.push(`| ${entry.name} | ${entry.checked ? "是" : "否（digest 關閉）"} | ${entry.matched === null ? "—" : entry.matched ? "是" : "否"} | ${entry.listCalls} |`);
  }
  lines.push("");
  lines.push("> `neg-model` 是負向自我檢查實例，刻意讓清單不含 `digestModel`，用來確認每回合都會被 `model-unavailable` 擋下。");
  lines.push("");
  lines.push("## 逐場景結果");
  lines.push("");
  lines.push("| 斷言 | 場景 | 結果 | 模型呼叫 | 寫入 | 耗時 |");
  lines.push("|---|---|---|---|---|---|");
  for (const entry of report.cases) {
    lines.push(
      `| ${entry.assertion ?? "—"} | ${entry.id} | ${statusLabel(entry.status)} | ${entry.metrics?.modelCalls ?? 0} | ${entry.metrics?.writes ?? 0} | ${entry.durationMs}ms |`,
    );
  }
  lines.push("");
  lines.push("## 九條斷言");
  lines.push("");
  const gatedAssertions = [];
  const reportOnlyAssertions = [];
  for (const assertion of ASSERTIONS) {
    const related = report.cases.filter((entry) => entry.assertion === assertion.id);
    const isReportOnly = related.length > 0 && related.every((entry) => entry.gated === false);
    (isReportOnly ? reportOnlyAssertions : gatedAssertions).push({ assertion, related });
  }
  lines.push("### 硬門檻項目（會影響退出碼）");
  lines.push("");
  lines.push("| # | 結果 | 斷言 | 對應場景 |");
  lines.push("|---|---|---|---|");
  for (const { assertion, related } of gatedAssertions) {
    const cases = related.map((entry) => `${entry.id}（${statusLabel(entry.status)}）`).join("、");
    lines.push(`| ${assertion.id} | ${statusLabel(assertionStatus(report, assertion.id))} | ${assertion.title} | ${cases || "—"} |`);
  }
  lines.push("");
  lines.push("### 僅報告項目（不影響退出碼）");
  lines.push("");
  lines.push("| # | 結果 | 斷言 | 對應場景 |");
  lines.push("|---|---|---|---|");
  for (const { assertion, related } of reportOnlyAssertions) {
    const cases = related.map((entry) => `${entry.id}（${statusLabel(entry.status)}）`).join("、");
    lines.push(`| ${assertion.id} | ${statusLabel(assertionStatus(report, assertion.id))} | ${assertion.title} | ${cases || "—"} |`);
  }
  lines.push("");
  lines.push("> `INFO` 代表這一項只輸出觀察值、不設硬門檻：不影響退出碼，也不代表通過或失敗。");
  lines.push("");
  lines.push("## 場景細節");
  lines.push("");
  for (const entry of report.cases) {
    lines.push(`### ${entry.id} — ${statusLabel(entry.status)}`);
    lines.push("");
    lines.push(entry.title);
    if (entry.detail !== undefined && entry.detail !== "") {
      lines.push("");
      lines.push(`> ${entry.detail}`);
    }
    if (entry.metrics !== undefined) {
      lines.push("");
      lines.push(`- 模型呼叫：${entry.metrics.modelCalls ?? 0}；寫入嘗試：${entry.metrics.writeAttempts ?? 0}；寫入成功：${entry.metrics.writes ?? 0}`);
    }
    const table = renderChecks(entry.checks);
    if (table !== "") {
      lines.push("");
      lines.push(table);
    }
    lines.push("");
  }
  lines.push("## 隱私");
  lines.push("");
  lines.push("- 報告只含場景結果與計數；不含對話全文、prompt、金鑰或 sessionID 明文。");
  lines.push("- `digest.log` 檔案的隱私檢查只掃檔案內容（console log 另有明文 sessionID，刻意不掃）。");
  lines.push("");
  return lines.join("\n");
}

export async function writeReport(report, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "loop-report.json");
  const mdPath = path.join(outDir, "loop-report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}

/** 主控台用的逐場景摘要（不印 prompt／對話內容）。 */
export function printCaseResult(entry, sanitize) {
  const status = statusLabel(entry.status).padEnd(7);
  const metrics = `model=${entry.metrics?.modelCalls ?? 0} writes=${entry.metrics?.writes ?? 0} attempts=${entry.metrics?.writeAttempts ?? 0}`;
  console.log(`[loop] ${status} ${entry.id.padEnd(32)} ${metrics}`);
  if (entry.status === "fail") {
    for (const check of entry.checks ?? []) {
      if (check.ok === false) {
        const expected = sanitize(formatReportValue(check.expected));
        const actual = sanitize(formatReportValue(check.actual));
        console.log(`[loop]        ✗ ${check.name}：預期 ${expected}，實際 ${actual}`);
      }
    }
    if (entry.detail !== undefined) console.log(`[loop]        ${sanitize(entry.detail)}`);
  }
}
