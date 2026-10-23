/**
 * L3 報告輸出（JSON＋Markdown）。
 *
 * 隱私邊界：
 * - 不含對話全文、prompt、金鑰、sessionID 明文或本機絕對路徑。
 * - 逐回合只放狀態、計數、期望針的命中情形與延遲；卡片內容本身不落地。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { formatReportValue, gitInfo, makeSanitizer } from "../../loop/report.mjs";

export { makeSanitizer };

function labelHard(ok) {
  return ok ? "PASS" : "FAIL";
}

function labelSoft(met) {
  if (met === true) return "INFO（達標）";
  if (met === false) return "INFO（未達標，待校準）";
  return "INFO（N/A）";
}

function pct(value) {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

/** 軟門檻的實際值：比率照舊印百分比；非數字（例如物件）走安全序列化，避免 NaN%／[object Object]。 */
function pctOrValue(value) {
  if (typeof value === "number") return pct(value);
  if (value === null || value === undefined) return "N/A";
  return formatReportValue(value);
}

function renderTurnTable(turns) {
  const lines = [
    "| 回合 | 結果 | 跳過原因 | 寫入 | items 原始→保留 | mustInclude | mustNotInclude | kind | 召回（查詢／注入／端到端） | 延遲 | parity |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const turn of turns) {
    const includeOk = turn.mustInclude.length === 0 ? "—" : turn.mustIncludeMissing.length === 0 ? "✓" : `✗（缺 ${turn.mustIncludeMissing.length}）`;
    const kindOk = turn.kindDetail.length === 0 ? "—" : `${turn.kindDetail.filter((entry) => entry.ok).length}/${turn.kindDetail.length}`;
    const recall = turn.recall === null ? "—" : `${turn.recall.queryHit ? "✓" : "✗"}／${turn.recall.injected ? "✓" : "✗"}／${turn.recall.queryHit && turn.recall.injected ? "✓" : "✗"}`;
    lines.push(
      `| ${turn.id} | ${turn.outcome}${turn.skipReason === null ? "" : `（${turn.skipReason}）`} | ${turn.expectSkip ?? "—"} | ${turn.written} | ${turn.rawItemCount}→${turn.keptItemCount} | ${includeOk} | ${turn.mustNotIncludeHits.length} | ${kindOk} | ${recall} | ${Math.round(turn.latencyMs)}ms | ${turn.parity?.ok === false ? "✗" : "✓"} |`,
    );
  }
  return lines.join("\n");
}

export function renderMarkdown(report, sanitize) {
  const lines = [];
  lines.push("# 對話記憶 L3：單模型摘要品質量測報告");
  lines.push("");
  lines.push(`- 產生時間：${report.generatedAt}`);
  lines.push(`- 總耗時：${(report.durationMs / 1000).toFixed(1)} 秒`);
  lines.push(
    `- git HEAD：\`${report.git.short ?? "?"}\`${report.git.dirty === true ? `（dirty：${report.git.dirtyFileCount} 個檔案）` : report.git.dirty === false ? "（clean）" : "（讀不到）"}`,
  );
  lines.push(`- fixture：\`${report.fixture.version}\`（${report.fixture.turns} 回合；指紋 \`${report.fixture.fingerprint}\`）`);
  if (report.output !== undefined) {
    lines.push(`- 報告位置：\`${report.output.json}\`、\`${report.output.md}\``);
  }
  lines.push(`- 模型：\`${report.model.id}\`（${report.model.kind}${report.model.paid ? "、付費" : "、不付費"}）`);
  lines.push(
    `- dist 重建：${report.build?.rebuilt === true ? `是（${report.build.reason ?? "dist 過期"}）` : "否（dist 比 src 新）"}`,
  );
  lines.push("");
  lines.push("## 硬條件（影響退出碼）");
  lines.push("");
  lines.push("| 結果 | 條件 | 實際 |");
  lines.push("|---|---|---|");
  for (const entry of report.hardConditions) {
    lines.push(`| ${labelHard(entry.ok)} | ${entry.label} | ${formatReportValue(entry.actual)} |`);
  }
  lines.push("");
  lines.push("## 軟門檻（僅報告，不影響退出碼）");
  lines.push("");
  lines.push("| 狀態 | 指標 | 門檻 | 實際 |");
  lines.push("|---|---|---|---|");
  for (const entry of report.softThresholds) {
    lines.push(`| ${labelSoft(entry.met)} | ${entry.label} | ${pct(entry.threshold)} | ${pctOrValue(entry.actual)} |`);
  }
  lines.push("");
  lines.push("> 軟門檻先當報告、尚未升為硬門檻；`INFO` 不代表通過，也不影響退出碼。");
  lines.push("");
  lines.push("## 摘要");
  lines.push("");
  lines.push(`- 回合：${report.metrics.turns}（digest ${report.metrics.digested}、跳過 ${report.metrics.skipped}、失敗 ${report.metrics.failed}）`);
  lines.push(`- 跳過原因：${JSON.stringify(report.metrics.skipReasons)}`);
  lines.push(`- 失敗原因：${JSON.stringify(report.metrics.failedReasons)}`);
  lines.push(`- 期望跳過：${report.metrics.skipExpectation.correct}/${report.metrics.skipExpectation.expected} 正確`);
  lines.push(
    `- 期望「有內容」：${report.metrics.emptyExpectation.nonEmptyWithWrites}/${report.metrics.emptyExpectation.nonEmpty} 有寫入；期望「空」：${report.metrics.emptyExpectation.correct}/${report.metrics.emptyExpectation.expected}`,
  );
  lines.push(
    `- parse 錯誤（\`not-json\`／\`shape\`）回合：${(report.metrics.failedReasons["not-json"] ?? 0) + (report.metrics.failedReasons.shape ?? 0)}`,
  );
  lines.push(`- items 被丟棄（rejected）：${report.metrics.itemsBudget.rejected} 筆（quote 不實、形狀不符等；不是 parse 錯誤）`);
  lines.push("");
  lines.push("## 指標");
  lines.push("");
  lines.push(`- mustInclude 通過：${report.metrics.mustInclude.passed}/${report.metrics.mustInclude.turnsWithExpectation}（${pct(report.metrics.mustInclude.rate)}）`);
  lines.push(`- mustNotInclude 命中：${report.metrics.mustNotInclude.hits}`);
  lines.push(`- 跨專案洩漏：${report.metrics.crossProjectLeaks}（內容層 ${report.crossProject.contentLeaks}、scope 層 ${report.crossProject.scopeLeaks}）`);
  lines.push(`- kind 命中：${report.metrics.kind.hits}/${report.metrics.kind.expected}（${pct(report.metrics.kind.rate)}）`);
  lines.push(
    `- 端到端召回：${report.metrics.recall.endToEnd}/${report.metrics.recall.expectedTurns}（${pct(report.metrics.recall.endToEndRate)}）；查詢命中 ${pct(report.metrics.recall.queryHitRate)}、實際注入 ${pct(report.metrics.recall.injectionRate)}`,
  );
  lines.push(
    "- 端到端召回口徑：期望內容被 server 召回**且**實際注入 `<memory-context>`；注入塊不標 agent，同一 marker 可能同時出現在原子 item 與回合卡，本口徑不區分來源卡別。",
  );
  lines.push(
    `- items 超限：原始 ${report.metrics.itemsBudget.rawItems} 筆 → parser 保留 ${report.metrics.itemsBudget.keptByParser} 筆 → 實際寫入 ${report.metrics.itemsBudget.writtenCards} 張；超限回合 ${report.metrics.itemsBudget.overLimitTurns} 個；rejected ${report.metrics.itemsBudget.rejected} 筆`,
  );
  lines.push(
    `- 延遲：模型 p50 ${report.metrics.latency.modelP50}ms／p95 ${report.metrics.latency.modelP95}ms；回合 p50 ${report.metrics.latency.turnP50}ms／p95 ${report.metrics.latency.turnP95}ms`,
  );
  lines.push(
    `- 逾時預算：digestTimeoutMs ${report.metrics.timeoutBudget.digestTimeoutMs}ms、2×p95 ${report.metrics.timeoutBudget.redundantThresholdMs}ms → ${report.metrics.timeoutBudget.ok ? "通過" : "未通過"}`,
  );
  lines.push("");
  lines.push("## 成本與 token");
  lines.push("");
  lines.push(`- token：${report.usage.tokens}`);
  lines.push(`- 成本：${report.usage.cost}`);
  lines.push(`- 說明：${report.usage.note}`);
  lines.push("");
  lines.push("## 卡片 parity（runtime POST ≡ buildDigestCards）");
  lines.push("");
  lines.push(`- 結果：${report.parity.ok ? "全部一致" : "有不一致"}`);
  if (!report.parity.ok) {
    for (const mismatch of report.parity.mismatches) {
      lines.push(`  - ${mismatch.id}：預期 ${mismatch.expectedCount} 張、實際 ${mismatch.actualCount} 張`);
    }
  }
  lines.push("");
  lines.push("## 測量有效性");
  lines.push("");
  if (report.recallHealth !== undefined) {
    lines.push(
      report.recallHealth.degradedSearches === 0
        ? "- 召回查詢全部走語意路徑（沒有 degraded）。"
        : `- **有 ${report.recallHealth.degradedSearches} 次召回查詢退回關鍵字（degraded）**；召回數字不可當語意召回解讀。`,
    );
    lines.push(
      `- 召回前向量就緒：${report.recallHealth.vectorReadiness.gate}（等待 ${(report.recallHealth.vectorReadiness.waitedMs / 1000).toFixed(1)} 秒）`,
    );
  }
  lines.push(`- 卡片 parity：${report.parity.ok ? "PASS" : "FAIL"}`);
  lines.push("");
  lines.push("## 逐回合明細");
  lines.push("");
  lines.push(renderTurnTable(report.turns));
  lines.push("");
  lines.push("## 限制");
  lines.push("");
  lines.push(
    report.model.kind === "canned"
      ? "- 本輪用的是 **canned 抽取式基線**：它只驗證管線與量測規則，數字**不代表**真實模型的摘要品質。真實模型請用 `--model <id>`（必要時加 `--allow-paid`）。"
      : "- 本輪用單一真實模型；只代表該模型、該 fixture 版本，不外推到其他模型。",
  );
  lines.push("- 沒有的 usage 一律標 `N/A`，不推估 token 或成本。");
  lines.push("- 報告不含對話全文、prompt、金鑰或 sessionID 明文。");
  lines.push("");
  return lines.join("\n");
}

export async function writeReport(report, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "digest-report.json");
  const mdPath = path.join(outDir, "digest-report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, `${renderMarkdown(report)}\n`, "utf8");
  return { jsonPath, mdPath };
}

export { gitInfo };
