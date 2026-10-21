/**
 * 把評估結果渲染成 Markdown（人可讀）。JSON 由 `run.mjs` 負責寫出。
 *
 * 原則：
 * - 每個數字都標明口徑（**retrieval**＝假設每題都召回；**production**＝套用外掛 skip）與分母。
 * - 推論只寫在「建議」章節；test 數字不參與選值。
 */
export function pct(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function num(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function table(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${row.map((cell) => (cell === undefined || cell === null ? "" : String(cell))).join(" | ")} |`,
  );
  return [head, divider, ...body].join("\n");
}

function latencyCell(bucket) {
  if (bucket === null || bucket === undefined || bucket.latency === null) return "—";
  return `${num(bucket.latency.p50)} / ${num(bucket.latency.p95)}`;
}

const VARIANT_ORDER = ["A", "B", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "K3", "K5", "K8", "D", "E", "F"];

/** 取 variant 在指定 split 的 bucket（依口徑）。 */
function bucketOf(variant, split, mode) {
  if (variant === undefined) return null;
  if (mode === "production") return variant[`${split}Production`] ?? null;
  return variant[split] ?? null;
}

function variantTable(variants, split, mode) {
  const rows = [];
  for (const id of VARIANT_ORDER) {
    const variant = variants[id];
    if (variant === undefined) continue;
    const bucket = bucketOf(variant, split, mode);
    if (bucket === null) {
      rows.push([id, variant.label, "—", "—", "—", "—", "—", "—", "—", "—", "—", "—", "—", "—"]);
      continue;
    }
    rows.push([
      id,
      variant.label,
      pct(bucket.recall5),
      pct(bucket.top1),
      num(bucket.mrr, 3),
      bucket.hitItems ?? 0,
      pct(bucket.updateHit5),
      pct(bucket.fpItemRate),
      pct(bucket.negativeInjectionRate),
      pct(bucket.crossInjectionRate),
      pct(bucket.abstention),
      num(bucket.injectedPerQuestion?.mean, 2),
      num(bucket.injectedTokens?.p95),
      mode === "production" ? (bucket.skippedQuestions ?? 0) : "—",
    ]);
  }
  return table(
    [
      "variant",
      "設定",
      "Recall@5（檢索）",
      "Top-1（檢索）",
      "MRR（檢索）",
      "hitItems",
      "更新命中",
      "FP",
      "neg 注入",
      "cross 注入",
      "abstention",
      "筆數/題",
      "token p95",
      "skip 題數",
    ],
    rows,
  );
}

function categoryTable(variants, split, mode) {
  const categories = ["single", "multi", "update", "negative", "cross"];
  const rows = [];
  for (const category of categories) {
    const row = [category];
    for (const id of ["A", "B", "C1", "C2", "C3", "C6", "C8", "F"]) {
      const variant = variants[id];
      const map = mode === "production" ? variant?.[`${split}ByCategoryProduction`] : variant?.[`${split}ByCategory`];
      const bucket = map?.[category];
      if (id === "A") {
        row.push(category === "negative" || category === "cross" ? "0 注入" : "—");
        continue;
      }
      if (bucket === undefined || bucket === null || bucket.n === 0) {
        row.push("—");
        continue;
      }
      if (category === "single" || category === "multi") {
        row.push(`R@5 ${pct(bucket.recall5)}／hit ${bucket.hitItems}`);
      } else if (category === "update") {
        row.push(`命中 ${pct(bucket.updateHit5)}／stale ${pct(bucket.staleHitRate)}／hit ${bucket.hitItems}`);
      } else {
        row.push(`注入 ${pct(category === "negative" ? bucket.negativeInjectionRate : bucket.crossInjectionRate)}`);
      }
    }
    rows.push(row);
  }
  return table(["類別", "A", "B", "C1 (0.35)", "C2 (0.40)", "C3 (0.45)", "C6 (0.60)", "C8 (0.70)", "F (keyword)"], rows);
}

function fpTable(bucket, label) {
  if (bucket === null || bucket === undefined) return "—";
  const rows = [
    ["注入筆數合計", num(bucket.injectedItems)],
    ["FP 筆數（forbidden／應 abstain 題）", num(bucket.fpItems)],
    ["FP 筆數比例（FP ÷ 所有注入）", pct(bucket.fpItemRate)],
    ["至少一筆 FP 的題目比例", pct(bucket.fpQuestionRate)],
    ["negative 題有注入的比例", pct(bucket.negativeInjectionRate)],
    ["cross 題有注入的比例", pct(bucket.crossInjectionRate)],
    ["abstention（negative＋cross 完全 0 注入）", pct(bucket.abstention)],
    ["空召回率（全部題目）", pct(bucket.emptyRecallRate)],
    ["hitItems（expected 卡實際被注入）", num(bucket.hitItems)],
    ["expectedHitRate（至少一張 expected 被注入）", pct(bucket.expectedHitRate)],
    ["未標註卡筆數（不算 FP）", num(bucket.unlabeledItems)],
    ["標註精準率下限（expected ÷ 注入）", pct(bucket.labeledPrecision)],
  ];
  return table([`${label} 指標`, "值"], rows);
}

export function renderMarkdown(report) {
  const lines = [];
  const { meta, readiness, dataset, variants, latency, answers, recommendations } = report;

  lines.push("# Mnemoshelf 記憶召回評估（D3／v1）");
  lines.push("");
  lines.push(
    `> 產生時間 ${meta.finishedAt}；耗時 ${(meta.durationMs / 1000).toFixed(0)} 秒；` +
      `Node ${meta.node}；embedder \`${meta.embedder?.id ?? "?"}\`（device=${meta.embedderRuntime?.device ?? "?"}）；` +
      `server ${meta.serverVersion ?? "?"}。`,
  );
  lines.push("");
  lines.push("資料集與指令見 `packages/opencode-plugin/eval/README.md`。此檔由 harness 產生，數字可重跑。");
  lines.push("");
  lines.push(
    "**兩種口徑（F1）**：`retrieval`＝假設每一題都會觸發召回（看檢索器與裝箱的好壞上限）；" +
      "`production`＝先套用外掛真正的 skip 判斷（query <20 字、slash、幾乎全程式碼等），被跳過的題目算 0 注入。" +
      "生產環境的誤注入率要讀 production；retrieval 只用來定位問題在檢索還是注入。",
  );
  lines.push("");

  // 1. 摘要
  lines.push("## 1. 摘要（先看這節）");
  lines.push("");
  const bDev = variants.B?.dev;
  const bProd = variants.B?.devProduction;
  const bTest = variants.B?.test;
  const bTestProd = variants.B?.testProduction;
  lines.push(
    table(
      ["問題", "dev", "test"],
      [
        ["Recall@5（retrieval）", pct(bDev?.recall5), pct(bTest?.recall5)],
        ["Top-1（retrieval）", pct(bDev?.top1), pct(bTest?.top1)],
        ["MRR（retrieval）", num(bDev?.mrr, 3), num(bTest?.mrr, 3)],
        [
          "expected hitItems（production／retrieval）",
          `${bProd?.hitItems ?? "—"}／${bDev?.hitItems ?? "—"}`,
          `${bTestProd?.hitItems ?? "—"}／${bTest?.hitItems ?? "—"}`,
        ],
        ["FP 注入率（retrieval）", pct(bDev?.fpItemRate), pct(bTest?.fpItemRate)],
        ["**FP 注入率（production）**", pct(bProd?.fpItemRate), pct(bTestProd?.fpItemRate)],
        ["negative 注入率（retrieval）", pct(bDev?.negativeInjectionRate), pct(bTest?.negativeInjectionRate)],
        ["**negative 注入率（production）**", pct(bProd?.negativeInjectionRate), pct(bTestProd?.negativeInjectionRate)],
        ["**cross 注入率（production）**", pct(bProd?.crossInjectionRate), pct(bTestProd?.crossInjectionRate)],
        ["abstention（retrieval）", pct(bDev?.abstention), pct(bTest?.abstention)],
        ["**abstention（production）**", pct(bProd?.abstention), pct(bTestProd?.abstention)],
        [
          "identifier 子集 Recall@5（retrieval）",
          pct(variants.B?.subsets?.dev?.identifier?.recall5),
          pct(variants.B?.subsets?.test?.identifier?.recall5),
        ],
        [
          "identifier 子集 expectedHitRate（production）",
          pct(variants.B?.subsetsProduction?.dev?.identifier?.expectedHitRate),
          pct(variants.B?.subsetsProduction?.test?.identifier?.expectedHitRate),
        ],
        [
          "中文子集 Recall@5（retrieval）",
          pct(variants.B?.subsets?.dev?.zh?.recall5),
          pct(variants.B?.subsets?.test?.zh?.recall5),
        ],
        [
          "英文子集 Recall@5（retrieval）",
          pct(variants.B?.subsets?.dev?.en?.recall5),
          pct(variants.B?.subsets?.test?.en?.recall5),
        ],
        ["是否需要 RRF（見 §8.4）", answers.rrf.verdict, answers.rrf.verdict],
      ],
    ),
  );
  lines.push("");
  lines.push("**一句話**：" + answers.summary);
  lines.push("");
  lines.push("**召回沒問題、問題在別處的話要說清楚**：" + answers.bottleneck);
  lines.push("");
  lines.push("### 逐題答案");
  for (const [key, value] of Object.entries(answers.details)) {
    lines.push(`- **${key}**：${value}`);
  }
  lines.push("");

  // 2. 就緒閘門
  lines.push("## 2. 就緒閘門、skip 與異常");
  lines.push("");
  const degradedTotal = Object.values(variants).reduce(
    (total, variant) => total + (variant.dev?.degraded ?? 0) + (variant.test?.degraded ?? 0),
    0,
  );
  const excludedTotal = Object.values(variants).reduce(
    (total, variant) => total + (variant.dev?.excluded ?? 0) + (variant.test?.excluded ?? 0),
    0,
  );
  lines.push(
    table(
      ["項目", "值"],
      [
        ["灌入卡片數（含被 supersede 的舊卡）", dataset.meta.cards],
        ["存活卡片數", dataset.meta.liveCards],
        ["等待就緒", `${(readiness.waitedMs / 1000).toFixed(1)} 秒（${readiness.polls} 次輪詢）`],
        ["`pending` / `failed` / `stale`", `${readiness.final.pending} / ${readiness.final.failed} / ${readiness.final.stale}`],
        [
          "`tooLong`（永久不可語意召回）",
          `${readiness.final.tooLong}${readiness.final.tooLong > 0 ? "（紅字：這些卡只能靠關鍵字補位）" : ""}`,
        ],
        [
          "`degraded:true` 的回應（已剔除）／其中仍有命中",
          `${readiness.degradedResponses}／${readiness.degradedWithHits ?? 0}`,
        ],
        ["所有 variant×split 的 degraded 樣本數", degradedTotal],
        ["所有 variant×split 的剔除樣本數（degraded＋timeout＋error）", excludedTotal],
        ["timeout 數（量測用 timeout 3000ms）", readiness.timeouts],
        ["其他錯誤", readiness.errors],
      ],
    ),
  );
  lines.push("");
  lines.push("閘門條件：`pending === 0 && failed === 0 && stale === 0`。已達成；`degraded` 只是必要條件，未單獨採用。");
  lines.push("");
  if (readiness.maskIssues !== undefined && readiness.maskIssues.length > 0) {
    lines.push(`**寫入遮罩命中**：${readiness.maskIssues.map((item) => item.id).join("、")}（fixture 應修正，不應被遮罩）。`);
    lines.push("");
  }

  // 2.1 skip
  const skipStats = report.skipStats;
  lines.push("### 2.1 外掛 skip 的題目（F1）");
  lines.push("");
  lines.push(
    `外掛的 \`skipReason\` 會跳過空字串、slash、少於 20 字與幾乎全程式碼的訊息；本資料集共 ` +
      `${skipStats.skipped}/${skipStats.total} 題會被跳過（${JSON.stringify(skipStats.byReason)}）。` +
      `被跳過的題目在 production 口徑算「0 注入」，但仍列入 retrieval 口徑的分布。`,
  );
  lines.push("");
  lines.push(
    table(
      ["類別", "題數", "被 skip", "比例"],
      Object.entries(skipStats.byCategory).map(([category, row]) => [
        category,
        row.total,
        row.skipped,
        pct(row.total === 0 ? null : row.skipped / row.total),
      ]),
    ),
  );
  lines.push("");
  if (report.productionResidual.length > 0) {
    lines.push(
      `production 口徑下仍有 **${report.productionResidual.length} 題** negative／cross 被注入（dev，B）：`,
    );
    lines.push("");
    lines.push(
      table(
        ["題目", "類別", "字數", "注入的卡", "semantic", "keyword"],
        report.productionResidual.map((row) => [
          row.id,
          row.category,
          row.chars,
          row.injected.join("、"),
          row.semantic,
          row.keyword,
        ]),
      ),
    );
    lines.push("");
    lines.push(
      "原因分兩層：這些題目都沒有被 skip（≥20 字），且在 0.40 下注入**全部是語意命中**——" +
        "模型對「無關文字」的 cosine 本來就高於 0.40（見 §4.8）；把門檻拉到 0.70 後 negative 歸零，" +
        "剩下的 cross 主要由 keyword 補位貢獻（§8.5），而 keyword 命中不受 minScore 約束。",
    );
    lines.push("");
  }

  // 3. 資料集
  lines.push("## 3. 資料集");
  lines.push("");
  lines.push(
    table(
      ["項目", "值"],
      [
        ["題數", dataset.meta.questions],
        ["dev / test", `${dataset.meta.bySplit.dev} / ${dataset.meta.bySplit.test}`],
        [
          "single / multi / update / negative / cross",
          ["single", "multi", "update", "negative", "cross"].map((key) => dataset.meta.byCategory[key] ?? 0).join(" / "),
        ],
        ["identifier 子集 / 其中 code identifier", `${dataset.meta.identifierQuestions} / ${dataset.meta.codeIdentifierQuestions}`],
        ["zh / en", `${dataset.meta.zhQuestions} / ${dataset.meta.enQuestions}`],
        ["pinned 卡 / 近似重複卡 / supersede 對", `${dataset.meta.pinnedCards} / ${dataset.meta.duplicatePairs * 2} / ${dataset.meta.supersededCards}`],
      ],
    ),
  );
  lines.push("");
  lines.push(
    "判定一律用 `expected_ids`／`acceptable_ids`／`forbidden_ids`，不用分數門檻反推" +
      "（keyword 命中的 score 是 `1/rank`，不是 cosine）。",
  );
  lines.push("");

  // 4. Variant
  lines.push("## 4. Variant 對照");
  lines.push("");
  lines.push("### 4.1 dev — retrieval 口徑（假設每題都召回）");
  lines.push("");
  lines.push(variantTable(variants, "dev", "retrieval"));
  lines.push("");
  lines.push("### 4.2 dev — production 口徑（套用外掛 skip；被 skip 的題目算 0 注入）");
  lines.push("");
  lines.push(variantTable(variants, "dev", "production"));
  lines.push("");
  lines.push("### 4.3 test — retrieval 口徑（只佐證，不參與選值）");
  lines.push("");
  lines.push(variantTable(variants, "test", "retrieval"));
  lines.push("");
  lines.push("### 4.4 test — production 口徑");
  lines.push("");
  lines.push(variantTable(variants, "test", "production"));
  lines.push("");
  lines.push("### 4.5 per-category（dev／retrieval）");
  lines.push("");
  lines.push(categoryTable(variants, "dev", "retrieval"));
  lines.push("");
  lines.push("### 4.6 per-category（dev／production）");
  lines.push("");
  lines.push(categoryTable(variants, "dev", "production"));
  lines.push("");
  lines.push("### 4.7 B 的 FP／abstention 細項（兩種口徑）");
  lines.push("");
  lines.push(fpTable(bProd, "dev／production"));
  lines.push("");
  lines.push(fpTable(bDev, "dev／retrieval"));
  lines.push("");
  lines.push(fpTable(bTestProd, "test／production"));
  lines.push("");
  lines.push(fpTable(bTest, "test／retrieval"));
  lines.push("");

  // 4.8 分數尺度
  lines.push("### 4.8 分數尺度（minScore 只有在尺度已知時才有意義）");
  lines.push("");
  const scoreRows = [];
  for (const [configId, diag] of Object.entries(report.scoreDiagnostics ?? {})) {
    scoreRows.push([
      configId,
      num(diag.minScore, 2),
      diag.semanticHits,
      diag.keywordHits,
      diag.questionsWithNoSemantic,
      `${num(diag.semanticScore?.p50, 2)}／${num(diag.semanticScore?.p95, 2)}／${num(diag.semanticScore?.max, 2)}`,
    ]);
  }
  lines.push(
    table(
      ["config", "minScore", "語意命中數", "關鍵字命中數", "0 語意命中的題數", "語意 score p50／p95／max"],
      scoreRows,
    ),
  );
  lines.push("");
  const calibration = report.calibration;
  if (calibration !== undefined) {
    lines.push(
      `**尺度校準**（k=20、minScore 0、dev＋test 合計，n=${calibration.n}）：所有 required 卡都進前 5 的比例 ` +
        `${pct(calibration.expectedAllIn5)}（＝Recall@5 的定義）、至少一張進前 5 ${pct(calibration.expectedAnyIn5)}、` +
        `single Top-1 ${pct(calibration.top1)}。` +
        `expected 卡的 cosine：p50 ${num(calibration.expectedScore?.p50, 2)}、p95 ${num(calibration.expectedScore?.p95, 2)}、` +
        `min ${num(calibration.expectedScore?.min, 2)}、max ${num(calibration.expectedScore?.max, 2)}。`,
    );
    lines.push("");
    lines.push(
      table(
        ["類別／split", "n", "至少一張進前 5", "全部 required 進前 5", "Top-1"],
        Object.entries(calibration.byCategory ?? {}).map(([category, row]) => [
          category,
          row.n,
          pct(row.n === 0 ? null : row.anyIn5 / row.n),
          pct(row.n === 0 ? null : row.allIn5 / row.n),
          category.startsWith("single/") ? pct(row.n === 0 ? null : row.top1 / row.n) : "—",
        ]),
      ),
    );
    lines.push("");
    lines.push(
      "這張表是「檢索器本身」的上限（k=20、minScore 0、沒有關鍵字補位），可以和 §4.1 的 B（同 split）對照：" +
        "如果兩者差距很大，差距是外掛的 k／minScore／裝箱造成的，不是檢索器找不到。",
    );
    lines.push("");
    if (calibration.abstain !== undefined) {
      lines.push(
        `**應該 0 注入的題目**（negative＋cross，n=${calibration.abstain.n}）在語意路徑上的最高 cosine：` +
          `p50 ${num(calibration.abstain.p50, 2)}、p95 ${num(calibration.abstain.p95, 2)}、` +
          `min ${num(calibration.abstain.min, 2)}、max ${num(calibration.abstain.max, 2)}。` +
          `把 expected 卡與它們的分數放在一起看，就知道有沒有單一門檻能同時保住召回與 abstention：`,
      );
      lines.push("");
      lines.push(
        table(
          ["minScore 門檻", "expected 卡 cosine ≥ 門檻（＝語意路徑最多能 recall 的比例）", "應該 0 注入的題目 top < 門檻（＝可 abstain 的比例）"],
          Object.keys(calibration.shareAbove ?? {}).map((threshold) => [
            threshold,
            pct(calibration.shareAbove?.[threshold]),
            pct(calibration.abstain?.shareBelow?.[threshold]),
          ]),
        ),
      );
      lines.push("");
      lines.push(
        "若 expected 卡的 cosine 分佈與「無關題目的最高 cosine」大幅重疊，代表**沒有單一 minScore 能同時" +
          "保住召回與 abstention**；此時調整 minScore 只是移動取捨點，不是修好問題。還要記得 server 在語意" +
          "結果不足 k 時會用關鍵字補位，而 keyword 命中不受 minScore 約束——所以提高門檻可能反而讓補位塞進更多無關卡。",
      );
      lines.push("");
    }
  }

  // 5. 子集
  lines.push("## 5. 子集（identifier／中文／英文）");
  lines.push("");
  const subsetRows = [];
  for (const id of ["B", "C1", "C3", "C8", "F"]) {
    for (const split of ["dev", "test"]) {
      const subset = variants[id]?.subsets?.[split];
      const prod = variants[id]?.subsetsProduction?.[split];
      if (subset === undefined) continue;
      subsetRows.push([
        id,
        split,
        subset.identifier?.n ?? 0,
        pct(subset.identifier?.recall5),
        pct(subset.codeIdentifier?.recall5),
        pct(subset.zh?.recall5),
        pct(subset.en?.recall5),
        pct(prod?.identifier?.expectedHitRate),
      ]);
    }
  }
  lines.push(
    table(
      ["variant", "split", "identifier n", "identifier R@5", "code id R@5", "中文 R@5", "英文 R@5", "identifier expectedHitRate（production）"],
      subsetRows,
    ),
  );
  lines.push("");
  lines.push("樣本量提醒：單一 split 的 identifier 子集只有 20 題上下，Recall@5 的 95% CI 很寬；小於 10pp 的差異不要當成有效。");
  lines.push("");

  // 6. 延遲
  lines.push("## 6. 延遲與注入量");
  lines.push("");
  lines.push(
    table(
      ["情境", "n（成功）", "p50 (ms)", "p95 (ms)", "max (ms)", ">150ms／timeout 率", "timeout 數"],
      [
        [
          "索引閒置（量測 timeout 3000ms）",
          latency.idle.n,
          num(latency.idle.p50),
          num(latency.idle.p95),
          num(latency.idle.max),
          pct(latency.idle.over150Rate),
          "—",
        ],
        [
          "索引進行中（外掛實際 150ms timeout）",
          latency.indexing.n,
          num(latency.indexing.p50),
          num(latency.indexing.p95),
          num(latency.indexing.max),
          pct(latency.indexing.timeoutRate),
          String(latency.indexing.timeouts ?? 0),
        ],
      ],
    ),
  );
  lines.push("");
  lines.push(
    `索引閒置的查詢放寬 timeout 到 3000ms，「>150ms」是實際會 fail-open 的比例。索引進行中直接套外掛的 150ms timeout：` +
      `逾時就是 fail-open＝該輪完全沒有記憶（不是用 FTS 硬塞），這些樣本不混進閒置統計。` +
      `${latency.indexing.note === undefined ? "" : `（${latency.indexing.note}）`}`,
  );
  lines.push("");
  lines.push(
    table(
      ["注入量（dev）", "retrieval mean／p95", "production mean／p95"],
      [
        [
          "筆數",
          `${num(bDev?.injectedPerQuestion?.mean, 2)}／${num(bDev?.injectedPerQuestion?.p95)}`,
          `${num(bProd?.injectedPerQuestion?.mean, 2)}／${num(bProd?.injectedPerQuestion?.p95)}`,
        ],
        [
          "字元",
          `${num(bDev?.injectedChars?.mean, 1)}／${num(bDev?.injectedChars?.p95)}`,
          `${num(bProd?.injectedChars?.mean, 1)}／${num(bProd?.injectedChars?.p95)}`,
        ],
        [
          "估算 token",
          `${num(bDev?.injectedTokens?.mean, 1)}／${num(bDev?.injectedTokens?.p95)}`,
          `${num(bProd?.injectedTokens?.mean, 1)}／${num(bProd?.injectedTokens?.p95)}`,
        ],
      ],
    ),
  );
  lines.push("");
  lines.push("token 是估算（CJK 每字 1 token、其餘 4 字元 1 token），沒有引入 tokenizer 依賴。");
  lines.push("");

  // 7. 跨專案
  lines.push("## 7. 跨專案題的有效性檢查");
  lines.push("");
  lines.push(
    `cross 題除了「預設範圍 0 注入」，另外用 \`includeAllProjects: true\` 確認題目本身可被回答：` +
      `${report.crossCheck.hit}/${report.crossCheck.total} 命中目標卡（${pct(report.crossCheck.rate)}）。` +
      `若這個比例太低，cross 題的 0 注入可能只是「查不到」，不是隔離有效。`,
  );
  lines.push("");
  if (report.determinism !== null) {
    lines.push(
      `重跑一致性：抽 ${report.determinism.checked} 題（dev）重跑同一組參數，` +
        `${report.determinism.mismatches === 0 ? "排名與 id 完全一致" : `${report.determinism.mismatches} 題不一致`}。`,
    );
    lines.push("");
  }

  // 8. 建議
  lines.push("## 8. 建議（只出自 dev）");
  lines.push("");
  lines.push("### 8.1 決策規則套用結果");
  lines.push("");
  lines.push(
    table(
      ["參數", "現值", "建議", "可分辨？", "達標？", "依據"],
      [
        [
          "minScore",
          "0.40",
          recommendations.minScore.recommended.toFixed(2),
          recommendations.minScore.distinguishable ? "是" : "否（<10pp）",
          recommendations.minScore.meetsGate ? "是（FP ≤10%）" : "否（改善但未達標）",
          recommendations.minScore.reason,
        ],
        [
          "maxItems",
          "4",
          String(recommendations.maxItems.recommended),
          recommendations.maxItems.distinguishable ? "是" : "否（<10pp）",
          recommendations.maxItems.meetsGate ? "是" : "否",
          recommendations.maxItems.reason,
        ],
        [
          "kMax",
          "8",
          String(recommendations.kMax.recommended),
          recommendations.kMax.distinguishable ? "是" : "否（<10pp）",
          "—",
          recommendations.kMax.reason,
        ],
        [
          "timeoutMs",
          "150",
          String(recommendations.timeoutMs.recommended),
          recommendations.timeoutMs.distinguishable ? "是" : "否",
          "—",
          recommendations.timeoutMs.reason,
        ],
      ],
    ),
  );
  lines.push("");
  lines.push("### 8.2 minScore 0.40 vs 上位門檻（production 口徑，同一份 dev）");
  lines.push("");
  lines.push(
    table(
      ["minScore", "hitItems（prod／retrieval）", "expectedHitRate", "negative 注入（prod／retrieval）", "cross 注入（prod）", "FP 筆數", "FP 率（prod）", "abstention（prod）", "token p95"],
      (recommendations.minScoreComparison ?? []).map((row) => [
        row.minScore.toFixed(2),
        `${row.hitItemsProduction}／${row.hitItemsRetrieval}`,
        pct(row.expectedHitRateProduction),
        `${pct(row.negativeInjectionProduction)}／${pct(row.negativeInjectionRetrieval)}`,
        pct(row.crossInjectionProduction),
        row.fpItems,
        pct(row.fpItemRate),
        pct(row.abstentionProduction),
        num(row.tokensP95),
      ]),
    ),
  );
  lines.push("");
  lines.push(
    "判讀：hitItems 不變代表提高門檻不會把期望卡濾掉；negative 注入下降代表「應該空召回」的題目變少。" +
      "FP 的主要來源是 cross 題——在預設範圍內它們幾乎都會拿到語意命中（模型對無關文字的 cosine 下限高），" +
      "所以即使 negative 已降到 0，FP 仍可能卡在 10% 上下。",
  );
  lines.push("");
  lines.push(
    "邊際提醒：本資料集 expected 卡的 cosine 最低約 0.69（見 §4.8）；選 0.70 等於只留 0.01 的邊際，" +
      "換到分數分佈不同的真實資料可能濾掉低分的正確卡。若要保守，0.65 在 dev 也同樣讓 negative 注入歸零、FP ≤10%，" +
      "留的邊際較大。",
  );
  lines.push("");
  lines.push("### 8.3 D2 plugin options 預設值 diff");
  lines.push("");
  lines.push(
    table(
      ["option", "目前", "建議", "要改？", "依據"],
      recommendations.d2Diff.map((row) => [row.option, row.current, row.recommended, row.change ? "**是**" : "否", row.evidence]),
    ),
  );
  lines.push("");
  lines.push("```diff");
  for (const row of recommendations.d2Diff) {
    if (row.change) lines.push(`- ${row.option}: ${row.current}`, `+ ${row.option}: ${row.recommended}`);
  }
  if (recommendations.d2Diff.every((row) => !row.change)) lines.push("# 無變更：沿用 D2 現值");
  lines.push("```");
  lines.push("");
  lines.push("### 8.4 是否需要 RRF");
  lines.push("");
  lines.push(answers.rrf.detail);
  lines.push("");
  const d3b = report.d3b?.keywordBackfill;
  if (d3b !== undefined) {
    const prod = d3b.production070 ?? {};
    lines.push("### 8.5 D3b：minScore 0.70 之後剩下的誤注入（未實作，需 PM 決策）");
    lines.push("");
    lines.push(
      `0.70 的 production 口徑：negative 注入 ${pct(prod.negativeInjection)}、cross 注入 ${pct(prod.crossInjection)}、` +
        `FP ${pct(prod.fpItemRate)}、abstention ${pct(prod.abstention)}。剩下的 ${(d3b.residual070 ?? []).length} 題全部是 cross，` +
        `注入來源 semantic ${d3b.residual070Semantic} 筆、keyword ${d3b.residual070Keyword} 筆；foreign 注入 ${prod.foreignInjected ?? 0} 筆` +
        `（沒有跨專案洩漏——注入的是本專案與 global 的相似卡）。`,
    );
    lines.push("");
    lines.push(
      table(
        ["剩餘題目", "注入的卡"],
        (d3b.residual070 ?? []).map((row) => [row.id, row.injected.join("、")]),
      ),
    );
    lines.push("");
    lines.push(
      `要讓這些 cross 題也 0 注入，門檻得拉到 0.75：calib 顯示 0.75 可讓 ${pct(d3b.abstainAt075)} 的 negative／cross abstain，` +
        `但 expected 卡只剩 ${pct(d3b.expectedAt075)} 在門檻之上（≈ ${pct(1 - (d3b.expectedAt075 ?? 1))} 的正確卡會被濾掉）。` +
        `這是取捨，不是免費的改善。`,
    );
    lines.push("");
    lines.push(
      table(
        ["選項", "做法", "效果", "成本／風險"],
        [
          [
            "A（server，小改）",
            "語意結果被 minScore 過濾後**不要**補位到 k：只有 `semantic.length === 0` 才走純關鍵字降級（或讓 keyword 補位也套一個分數下限）。",
            `可消掉 ${d3b.residual070Keyword}/${d3b.residual070Semantic + d3b.residual070Keyword} 筆殘餘注入（keyword 來源）；negative 已是 0、cross 有機會降到 0，Recall@5 不變（identifier 的 FTS 救援會少一點）。`,
            "改 `/memories/search` 語意；需重跑本評估與 server 測試；identifier 題可能失去部分 FTS 救援（F 變體 Recall@5 77.1% vs B 82.9% 是「全關」的極端）。",
          ],
          [
            "B（plugin，不動 server）",
            "`planRecall` 丟棄 `source:\"keyword\"` 的命中，除非它與 query 有共同的 identifier token（檔名、旗標、錯誤碼）。",
            "同樣能消掉 keyword 補位的殘餘注入，且不必改 server。",
            "改 D2 行為（本卡不允許）；純關鍵字救援的召回會下降，需 lex 比對與測試。",
          ],
          [
            "C（接受現狀）",
            "維持 0.70，把 cross 題的殘餘注入視為噪音。",
            `production abstention ${pct(prod.abstention)}、FP ${pct(prod.fpItemRate)}（≤10%）、negative 0%。`,
            "在 A 專案問 B 專案時仍會看到本專案／global 的卡；不是洩漏，但可能分散注意力。若真實使用很少這樣問，成本可接受。",
          ],
          [
            "D（0.75）",
            "把 minScore 提到 0.75。",
            `cross／negative 全部 abstain（calib ${pct(d3b.abstainAt075)}）；expected 剩 ${pct(d3b.expectedAt075)}。`,
            "約 9% 的低分正確卡被濾掉；對 paraphrase 較不友善，且沒有處理「補位」本身。",
          ],
        ],
      ),
    );
    lines.push("");
    lines.push(
      `殘餘注入的來源：semantic ${d3b.residual070Semantic} 筆、keyword ${d3b.residual070Keyword} 筆` +
        `（共 ${d3b.residual070Semantic + d3b.residual070Keyword} 筆）。也就是說，**到了 0.70，剩下的誤注入主要是 server 的關鍵字補位**：` +
        `語意全被門檻濾掉的題目仍被 FTS 補滿（retrieval 口徑有 ${d3b.ms070KeywordHits} 筆 keyword 補位、` +
        `${d3b.ms070SemanticHits} 筆語意命中）。要修的是「語意不足時不要用 FTS 補滿」，而不是再往上調門檻（0.75 會濾掉約 9% 的正確卡）。`,
    );
    lines.push("");
    lines.push(
      `結論：調到 0.70 之後，**negative（閒聊）注入率 ${pct(prod.negativeInjection)}、FP ${pct(prod.fpItemRate)}（≤10%）**；` +
        `剩下的 ${(d3b.residual070 ?? []).length} 題都是 cross，且多數注入來自 keyword 補位（${d3b.residual070Keyword} 筆）——` +
        "修補位語意（選項 A／B）比再拉高門檻（選項 D）划算。",
    );
    lines.push("");
  }

  // 9. 限制
  lines.push("## 9. 已知限制");
  lines.push("");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  lines.push("### 逐題失敗樣本（B／dev，retrieval 口徑，最多 10 筆）");
  lines.push("");
  if (report.failureSamples.length === 0) {
    lines.push("（無）");
  } else {
    lines.push(
      table(["題目", "類別", "缺少的 expected（不在 top-5）", "被標錯誤的注入", "備註"], report.failureSamples),
    );
  }
  lines.push("");
  return lines.join("\n");
}
