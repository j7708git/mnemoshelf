/**
 * 矩陣報告（JSON＋Markdown）。
 *
 * 隱私邊界：
 * - 不含 prompt、對話全文、金鑰、server URL、sessionID 明文或本機絕對路徑。
 * - 模型只以 `matrix-models.json` 的 id／digestModel 呈現；環境變數只列名稱與是否有值。
 * - 錯誤訊息在落地前會經過 sanitizer，並且已經在 transport 層截短。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { gitInfo, makeSanitizer } from "../../loop/report.mjs";

export { gitInfo, makeSanitizer };

const STATUS_LABEL = {
  RANKED: "RANKED",
  "NOT RUN": "NOT RUN",
  ERROR: "ERROR",
};

function pct(value) {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function ms(value) {
  return value === null || value === undefined ? "N/A" : `${value}ms`;
}

function mark(ok) {
  return ok === true ? "PASS" : "FAIL";
}

function cell(value) {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function recallCell(signals) {
  if (signals === null) return "—";
  const { recall } = signals;
  return `${recall.endToEnd}/${recall.expectedTurns}（${pct(recall.endToEndRate)}）`;
}

function contentHitCell(signals) {
  if (signals === null) return "—";
  const { mustInclude } = signals;
  return `${mustInclude.passed}/${mustInclude.turnsWithExpectation}（${pct(mustInclude.rate)}）`;
}

function writeCell(signals) {
  if (signals === null) return "—";
  const { writes } = signals;
  return `${writes.turnCards}＋${writes.atomicItems}＝${writes.total} 張`;
}

function eventCell(signals) {
  if (signals === null) return "—";
  return `獨立事件 ${signals.hardEvents.independentEvents}`;
}

function renderEnvironment(report) {
  const lines = [];
  lines.push("## 環境與設定");
  lines.push("");
  lines.push(`- Node：${report.environment.node}（${report.environment.platform}）`);
  lines.push(
    `- fixture：\`${report.fixture.version}\`（${report.fixture.evaluatedTurns}/${report.fixture.turns} 回合；模式 ${report.fixture.mode}；指紋 \`${report.fixture.fingerprint}\`）`,
  );
  lines.push(`- 模型選擇：${report.options.models.join("、")}`);
  lines.push(`- ` + "`--allow-paid`" + `：${report.options.allowPaid ? "有" : "沒有"}`);
  lines.push(`- ` + "`--max-calls`" + `：${report.budget.limit}（實際呼叫 ${report.budget.used} 次）`);
  lines.push(
    `- dist 重建：${report.build?.checked === false ? "未執行（沒有可跑的模型）" : report.build?.rebuilt === true ? `是（${report.build.reason ?? "dist 過期"}）` : "否（dist 比 src 新）"}`,
  );
  lines.push("");
  return lines.join("\n");
}

function renderStatus(report) {
  const lines = ["## 模型狀態", "", "| 模型 | transport | digestModel | 狀態 | 原因 |", "|---|---|---|---|---|"];
  for (const model of report.models) {
    lines.push(
      `| ${cell(model.label)} | \`${model.transport}\` | \`${model.digestModel}\` | **${STATUS_LABEL[model.status] ?? model.status}** | ${cell(model.reason ?? "—")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderRanking(report) {
  const lines = ["## 排行榜", ""];
  const ranked = report.models.filter((model) => model.status === "RANKED");
  if (ranked.length === 0) {
    lines.push("本輪沒有任何模型完成（全部 NOT RUN／ERROR），所以沒有可排名次。");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(
    "| 名次 | 模型 | 硬門檻（獨立事件） | JSON 成功率 | turn 非空率 | rejected items | mustInclude | mustNotInclude | kind | 寫入（回合卡＋item＝合計） | 端到端召回 | 內容命中 | p50 | p95 | 逾時率 | token | 成本 | API 錯誤 |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const model of ranked.slice().sort((left, right) => left.rank - right.rank)) {
    const signals = model.signals;
    const passed = model.gates.filter((gate) => gate.ok).length;
    const errors = Object.entries(signals.errorCounts)
      .map(([name, count]) => `${name}×${count}`)
      .join("、");
    lines.push(
      `| ${model.rank} | ${cell(model.label)} | ${passed}/${model.gates.length}（${eventCell(signals)}） | ${pct(signals.jsonSuccess.rate)}（${signals.jsonSuccess.ok}/${signals.jsonSuccess.total}） | ${pct(signals.turnNonEmpty.rate)} | ${signals.rejectedItems} | ${pct(signals.mustInclude.rate)}（${signals.mustInclude.passed}/${signals.mustInclude.turnsWithExpectation}） | ${signals.mustNotIncludeHits} | ${pct(signals.kind.rate)}（${signals.kind.hits}/${signals.kind.expected}） | ${writeCell(signals)} | ${recallCell(signals)} | ${contentHitCell(signals)} | ${ms(signals.latency.p50Ms)} | ${ms(signals.latency.p95Ms)} | ${pct(signals.timeouts.rate)}（${signals.timeouts.count}/${signals.timeouts.total}） | ${model.usage.tokens} | ${model.usage.cost} | ${cell(errors === "" ? "—" : errors)} |`,
    );
  }
  lines.push("");
  lines.push(
    "排名規則：硬門檻通過數 → mustInclude → kind → 端到端召回 → p95（低者優先）。" +
      "NOT RUN／ERROR 的模型不進排名。",
  );
  lines.push("");
  lines.push("> 除了「硬門檻」欄之外，其他欄位都是 `INFO`（只報告、不設門檻），不代表 PASS。");
  lines.push(
    "> 「寫入」欄是 `回合卡＋原子 item＝合計`；不要把原子 item 數誤讀成總張數。",
  );
  lines.push("");
  return lines.join("\n");
}

function renderGates(report) {
  const lines = ["## 硬門檻逐模型", ""];
  for (const model of report.models) {
    lines.push(`### ${model.label}（${STATUS_LABEL[model.status] ?? model.status}）`);
    lines.push("");
    if (model.status !== "RANKED" || model.gates.length === 0) {
      lines.push(`${STATUS_LABEL[model.status] ?? model.status}：${model.reason ?? "沒有可判定的指標"}`);
      lines.push("");
      continue;
    }
    lines.push("| 結果 | 條件 | 實際 |");
    lines.push("|---|---|---|");
    for (const gate of model.gates) {
      lines.push(`| ${mark(gate.ok)} | ${cell(gate.label)} | ${cell(gate.actual)} |`);
    }
    const passed = model.gates.filter((gate) => gate.ok).length;
    lines.push("");
    lines.push(`小計：**${passed}/${model.gates.length}** 條通過；去重後**獨立事件 ${model.signals.hardEvents.independentEvents}** 個。`);
    lines.push(
      `- mustNotInclude 命中回合（id）：${model.signals.hardEvents.mustNotIncludeHits.length === 0 ? "無" : model.signals.hardEvents.mustNotIncludeHits.join("、")}`,
    );
    lines.push(
      `- 跨專案（內容層）命中回合（id）：${model.signals.hardEvents.crossProjectHits.length === 0 ? "無" : model.signals.hardEvents.crossProjectHits.join("、")}；scope 層事件：${model.signals.hardEvents.scopeLeakEvents}`,
    );
    lines.push(
      `- 兩條門檻的獨立性：mustNotInclude 與跨專案洩漏在本次 fixture ${report.gateOverlap?.sameNeedle === true ? `指向同一根針（${report.gateOverlap.turnIds.join("、")}），同一次命中會同時讓兩條 FAIL` : "使用不同的針"}；因此 ${passed}/${model.gates.length} 只反映 **${model.signals.hardEvents.independentEvents}** 個獨立事件。`,
    );
    lines.push("");
  }
  return lines.join("\n");
}

function renderSpike(report) {
  const lines = ["## S6 spike：OpenCode `/api/experimental/generate`", ""];
  const findings = report.spike.findings;
  lines.push(`- 結論：${findings.conclusion}`);
  lines.push(`- 端點：\`${findings.endpoint}\`（operationId \`${findings.operationId}\`）`);
  lines.push(
    `- 認證：${findings.auth.scheme}；username=\`${findings.auth.username}\`、password 來自環境變數 \`${findings.auth.passwordEnv}\`（${findings.auth.passwordSource}）。` +
      `無認證 → HTTP ${findings.auth.unauthenticatedStatus}。`,
  );
  lines.push(`- 200 回應：\`${JSON.stringify(findings.response.body)}\`（${findings.response.notes.join("；")}）`);
  const request = findings.request;
  lines.push(
    `- 請求：\`POST\`、\`content-type: application/json\`；body \`${JSON.stringify(request.body)}\`。${request.notes.join(" ")}`,
  );
  if (findings.minimalExchange !== undefined) {
    lines.push(
      `- 最小實測：request \`${JSON.stringify(findings.minimalExchange.request)}\` → 200 \`${JSON.stringify(findings.minimalExchange.response)}\`。`,
    );
  }
  lines.push("- 錯誤碼：");
  for (const entry of findings.errorCodes) {
    lines.push(`  - ${entry.status} \`${entry.tag}\`：${entry.when}`);
  }
  lines.push(
    `- 延遲：認證後 \`GET /openapi.json\` 約 ${findings.latency.openapiProbeMs}ms；最小 generate 實測 ${findings.latency.minimalGenerateMs.join("／")}ms（${findings.latency.minimalGenerateNote}）。`,
  );
  lines.push(
    `- 嘗試過的埠：${findings.portsTried
      .map((port) => `${port.port}${port.usable ? " 可用" : " 不可用"}`)
      .join("、")}；spike 採用 ${findings.chosenPort}。`,
  );
  lines.push("");
  if (report.spike.probes.length > 0) {
    lines.push("本輪即時探測（唯讀 `GET /openapi.json`，不呼叫模型）：");
    lines.push("");
    lines.push("| 模型 | 可達 | 認證 | HTTP | 端點存在 | 延遲 | 備註 |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const probe of report.spike.probes) {
      lines.push(
        `| ${cell(probe.modelId)} | ${probe.reachable ? "是" : "否"} | ${probe.authOk ? "通過" : "未通過"} | ${probe.status ?? "—"} | ${probe.endpointExists === true ? "是" : probe.endpointExists === false ? "否" : "未知"} | ${ms(probe.latencyMs)} | ${cell(probe.message ?? "—")} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderTurnTable(turns) {
  const lines = [
    "| 回合 | 結果 | 跳過原因 | 回合卡 | 原子 item | 合計 | mustInclude | mustNotInclude | 跨專案 | kind | 召回（查詢／注入／端到端） | 延遲 | parse |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const turn of turns) {
    const includeOk =
      turn.mustIncludeMissing.length === 0 ? "—" : `✗（缺 ${turn.mustIncludeMissing.length}）`;
    const kindOk =
      turn.kindDetail.length === 0
        ? "—"
        : `${turn.kindDetail.filter((entry) => entry.ok).length}/${turn.kindDetail.length}`;
    const recall =
      turn.recall === null
        ? "—"
        : `${turn.recall.queryHit ? "✓" : "✗"}／${turn.recall.injected ? "✓" : "✗"}／${turn.recall.queryHit && turn.recall.injected ? "✓" : "✗"}`;
    // 命中的是「本列這個回合」；兩欄都只放 id／計數，不放 needle 或模型輸出文字。
    const mustNotIncludeCell =
      turn.mustNotIncludeHits.length === 0 ? "—" : `✗（${turn.mustNotIncludeHits.join("、")}）`;
    const crossProjectCell =
      turn.crossProjectHits.length === 0 ? "—" : `✗（${turn.crossProjectHits.join("、")}）`;
    lines.push(
      `| ${turn.id} | ${turn.outcome} | ${cell(turn.skipReason ?? "—")} | ${turn.turnCardWritten ? 1 : 0} | ${turn.atomicItemsWritten} | ${turn.written} | ${includeOk} | ${mustNotIncludeCell} | ${crossProjectCell} | ${kindOk} | ${recall} | ${Math.round(turn.latencyMs)}ms | ${cell(turn.parseError ?? "—")} |`,
    );
  }
  return lines.join("\n");
}

function renderModelDetail(report) {
  const lines = ["## 逐模型明細", ""];
  for (const model of report.models) {
    lines.push(`### ${model.label}`);
    lines.push("");
    lines.push(`- 狀態：**${STATUS_LABEL[model.status] ?? model.status}**${model.reason === null ? "" : `（${model.reason}）`}`);
    lines.push(`- 呼叫嘗試：${model.attempts} 次；token：${model.usage.tokens}；成本：${model.usage.cost}（${model.usage.note}）`);
    if (model.status !== "RANKED" || model.signals === null) {
      lines.push("");
      continue;
    }
    const signals = model.signals;
    lines.push(
      `- JSON 成功率：${signals.jsonSuccess.ok}/${signals.jsonSuccess.total}（${pct(signals.jsonSuccess.rate)}）；turn 非空：${signals.turnNonEmpty.ok}/${signals.turnNonEmpty.total}（${pct(signals.turnNonEmpty.rate)}）；rejected items：${signals.rejectedItems}`,
    );
    lines.push(
      `- mustInclude：${signals.mustInclude.passed}/${signals.mustInclude.turnsWithExpectation}（${pct(signals.mustInclude.rate)}）；mustNotInclude 命中：${signals.mustNotIncludeHits}；kind：${signals.kind.hits}/${signals.kind.expected}（${pct(signals.kind.rate)}）`,
    );
    lines.push(
      `- 寫入：回合卡 ${signals.writes.turnCards} 張＋原子 item ${signals.writes.atomicItems} 張＝**合計 ${signals.writes.total} 張**（與 digest.log 的 written 一致：${signals.writes.consistent ? "是" : "否"}）；parser 原始 ${signals.itemsBudget.rawItems} → 保留 ${signals.itemsBudget.keptByParser}；rejected ${signals.itemsBudget.rejected} 筆`,
    );
    lines.push(
      `- 端到端召回：${recallCell(signals)}（查詢命中 ${pct(signals.recall.queryHitRate)}、實際注入 ${pct(signals.recall.injectionRate)}）`,
    );
    lines.push(
      `- 延遲：p50 ${ms(signals.latency.p50Ms)}、p95 ${ms(signals.latency.p95Ms)}（嘗試 ${signals.latency.attempts} 次）；逾時 ${signals.timeouts.count}/${signals.timeouts.total}（${pct(signals.timeouts.rate)}）`,
    );
    lines.push(
      `- 延遲樣本（ms，順序即呼叫順序；可由此重算 p50／p95）：${signals.latency.samplesMs.length === 0 ? "無" : `[${signals.latency.samplesMs.join(", ")}]`}`,
    );
    lines.push(
      `- 逾時預算Ａ（該模型）：${signals.latency.modelTimeoutMs}ms ÷ 2 = ${signals.latency.modelBudgetMs}ms → p95 ${ms(signals.latency.p95Ms)}`,
    );
    lines.push(
      `- 逾時預算Ｂ（production）：${signals.latency.productionTimeoutMs}ms ÷ 2 = ${signals.latency.productionBudgetMs}ms → p95 ${ms(signals.latency.p95Ms)}；絕對上限 ${signals.latency.absoluteLimitMs}ms`,
    );
    lines.push(
      `- API 錯誤分類：${Object.keys(signals.errorCounts).length === 0 ? "無" : Object.entries(signals.errorCounts).map(([name, count]) => `${name}×${count}`).join("、")}`,
    );
    lines.push(
      `- 測量有效性：卡片 parity ${model.measurement.parity ? "一致" : "不一致"}；degraded 查詢 ${model.measurement.degradedSearches} 次；向量就緒 ${model.measurement.vectorReadiness}`,
    );
    lines.push("");
    if (Array.isArray(model.turns) && model.turns.length > 0) {
      lines.push("逐回合明細：");
      lines.push("");
      lines.push(renderTurnTable(model.turns));
      lines.push("");
    }
  }
  return lines.join("\n");
}

function renderDiscrimination(report) {
  const lines = ["## 硬條件鑑別力（canned 基線 vs 真模型）", ""];
  lines.push("| 條件 | canned 基線 | 真模型 | 為什麼 |");
  lines.push("|---|---|---|---|");
  for (const entry of report.discrimination) {
    lines.push(`| ${cell(entry.condition)} | ${cell(entry.canned)} | ${cell(entry.real)} | ${cell(entry.why)} |`);
  }
  lines.push("");
  lines.push(
    "> canned 基線只驗證管線與量測規則；它在上述條件的 PASS 多半是**結構性成立**，不能外推成真模型安全或快。",
  );
  lines.push("");
  return lines.join("\n");
}

function renderLimits(report) {
  const lines = ["## 口徑與限制", ""];
  lines.push(
    "- **端到端召回**的口徑是「期望內容被 server 召回**且**實際注入 `<memory-context>`」。注入塊不標 agent，同一 marker 可能同時出現在原子 item 與回合卡；本口徑不區分來源卡別。",
  );
  lines.push("- `rejected items` 是被 parser **丟棄**的 item 數（quote 不實、形狀不符等），不是 parse 錯誤；parse 錯誤回合另計在 JSON 成功率。");
  lines.push("- **寫入張數**一律寫成「回合卡＋原子 item＝合計」；回合卡與原子 item 是不同 payload，不能相加前後混讀。");
  lines.push(
    report.gateOverlap?.sameNeedle === true
      ? `- **兩條門檻不是兩個獨立缺陷**：本次 fixture 的跨專案 marker 同時是 ${report.gateOverlap.turnIds.join("、")} 的 mustNotInclude 針；同一次輸出會同時讓兩條 FAIL。排行榜的「獨立事件」已依回合去重。`
      : "- mustNotInclude 與跨專案洩漏在本 fixture 使用不同的針，各自獨立。",
  );
  lines.push("- 沒有 usage 的端點（例如 OpenCode generate）一律標 `N/A`，不推估 token 或成本。");
  lines.push("- 每輪只代表「這些模型 × 這份 fixture 版本 × 這個回合範圍」；篩選模式（screening）只跑前 N 回合，不能與完整 30 回合混為一談。");
  lines.push("- 模型端點的溫度固定 0（openai transport），但雲端模型仍可能非決定性；重跑數字不保證逐位元相同。");
  lines.push("- 宿主 `ctx.model.list()` 的 digestModel 驗證仍走 harness 的 `canned/digest-model`；本矩陣的 `digestModel` 是**被轉送的目標模型標籤**，不是產品設定。");
  lines.push(
    "- 本輪的 fixture 篩選：" +
      (report.fixture.mode === "full"
        ? "完整 30 回合。"
        : `screening 前 ${report.fixture.evaluatedTurns} 回合（預設成本保護；完整比較請加 \`--turns all\`）。`),
  );
  lines.push("");
  return lines.join("\n");
}

function renderPrivacy(report) {
  return [
    "## 隱私",
    "",
    `- 報告不含 prompt、對話全文、金鑰、server URL 或本機絕對路徑（掃描樣式：${report.privacy.patterns.join("、")}）。`,
    "- 環境變數只記錄**名稱與是否有值**，不記錄值。",
    "",
  ].join("\n");
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("# 對話記憶 L3 矩陣：三模型同條件比較");
  lines.push("");
  lines.push(`- 產生時間：${report.generatedAt}`);
  lines.push(`- 總耗時：${(report.durationMs / 1000).toFixed(1)} 秒`);
  lines.push(
    `- git HEAD：\`${report.git.short ?? "?"}\`${report.git.dirty === true ? `（dirty：${report.git.dirtyFileCount} 個檔案）` : report.git.dirty === false ? "（clean）" : "（讀不到）"}`,
  );
  if (report.output !== undefined) {
    lines.push(`- 報告位置：\`${report.output.json}\`、\`${report.output.md}\``);
  }
  lines.push("");
  lines.push(renderEnvironment(report));
  lines.push(renderStatus(report));
  lines.push(renderRanking(report));
  lines.push(renderGates(report));
  lines.push(renderSpike(report));
  lines.push(renderModelDetail(report));
  lines.push(renderDiscrimination(report));
  lines.push(renderLimits(report));
  lines.push(renderPrivacy(report));
  return lines.join("\n");
}

export async function writeReport(report, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "matrix-report.json");
  const mdPath = path.join(outDir, "matrix-report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, `${renderMarkdown(report)}\n`, "utf8");
  return { jsonPath, mdPath };
}
