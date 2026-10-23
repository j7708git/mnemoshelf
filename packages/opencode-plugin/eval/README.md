# 記憶召回離線評估（D3）

這個目錄是一套**可重跑**的召回評估：用合成記憶卡與標註題目，量 v1 外掛（`src/recall.ts`）
的召回率、誤注入、abstention、注入量與延遲。它**不改 server 的搜尋演算法**，也不改外掛行為；
唯一重用方式是 import 已建置的純函式（`dist/recall.js` 的 `planRecall`、`isDuplicate`，
`dist/config.js` 的 `readSettings`）——沒有為了 eval 改任何外掛行為。

```
eval/
├── run.mjs              # 入口：啟動 server → 灌 fixtures → 就緒閘門 → 量測 → 報告
├── lib/
│   ├── dataset.mjs      # 讀取＋驗證 fixtures（錯誤會指出位置）
│   ├── metrics.mjs      # 指標（Recall@5／MRR／FP／abstention／token 估算／百分位）
│   ├── select.mjs       # 只用 dev 的選值規則（minScore／maxItems／kMax／timeoutMs）
│   └── report.mjs       # Markdown 渲染
└── fixtures/
    ├── cards.json       # 合成記憶卡（alpha／beta／gamma＋global）
    └── questions.json   # 120 題標註（dev／test 各 60）
```

---

## 1. 怎麼跑

### 前置需求

| 項目 | 需求 |
|---|---|
| Node | 22 以上（與 repo 相同） |
| pnpm | 10 |
| 建置 | `pnpm -r build`（harness 發現 `dist` 不存在時會自動跑；可加 `--no-build` 禁止） |
| embedder 模型 | **現成快取**，不會下載。依序找：`MNEMOSHELF_MODEL_DIR`、`~/.config/Mnemoshelf/models`、`~/.local/share/mnemoshelf/models`、`~/Library/Application Support/Mnemoshelf/models`、`<repo>/.tmp/speed-diagnosis/models`；需要 `onnx-community/embeddinggemma-2-ONNX/onnx/model_q4.onnx`。找不到就明確失敗。 |
| 網路 | 不需要；只連 `127.0.0.1`。 |

### 一鍵執行

```bash
pnpm --filter @mnemoshelf/opencode-plugin eval
```

等價於 `node packages/opencode-plugin/eval/run.mjs`。輸出在 `.tmp/eval-d3/`（已被 gitignore）：

- `eval-report.json`：機器可讀（含每個 variant 的 dev／test 聚合、延遲、選值理由）。
- `eval-report.md`：人可讀摘要與表格。

參數：

| 參數 | 預設 | 說明 |
|---|---|---|
| `--out <dir>` | `<repo>/.tmp/eval-d3` | 報告輸出目錄 |
| `--readiness-timeout-min N` | `15` | 等記憶向量就緒的上限（分鐘） |
| `--keep` | 關 | 保留暫存資料目錄（除錯用；**內含測試 DB，不含使用者資料**） |
| `--no-build` | 關 | `dist` 不存在時直接失敗，不自動建置 |
| `--no-index-pass` | 關 | 跳過「索引進行中」的延遲量測 |
| `--no-determinism` | 關 | 跳過重跑一致性檢查（20 題） |
| `--verbose` | 關 | 把 server 的 stderr 也印出來 |

### 實際耗時（本機、CPU、q4 模型，2026-10-21 實測）

| 階段 | 時間 |
|---|---|
| server 啟動＋模型載入（第一次查詢前） | 約 5–15 秒 |
| 灌入 92 張卡（`POST /memories`） | < 1 秒（向量在背景建立） |
| **就緒閘門**（92 張卡的向量） | 約 12–14 秒 |
| 檢索（120 題 × 12 組設定） | 約 2.5–3 分鐘 |
| 索引進行中的延遲（60 題＋6 個合成檔） | 約 25–35 秒 |
| 總計 | **約 4 分鐘** |

（實測 2026-10-21（CPU、q4、512 維）：就緒 12.1 秒、檢索 146.5 秒（12 組設定）、
索引中延遲 27.5 秒、總耗時 192.6 秒（wall time 約 3 分 14 秒，含 server 啟動與收尾）。）

第一次跑若需要 `pnpm -r build`，再加 1–2 分鐘。上限請抓 30 分鐘：超過就代表環境有問題
（模型在 CPU 上異常慢、或就緒閘門卡住），harness 會在 15 分鐘時中止。

---

## 2. 資料從哪裡來、怎麼載入

**全部是合成資料**：三個虛構專案（`alpha` 建置工具、`beta` 限流服務、`gamma` 資料匯入器）
＋ 10 張 `global` 卡。沒有真實專案、真名、email、憑證或本機絕對路徑；`test/eval-fixtures.test.ts`
會掃描這幾類字串。

### 2.1 `cards.json`

```json
{
  "id": "alpha-cache-key-hash",
  "project": "alpha",
  "kind": "decision",
  "content": "建置快取的 key 改用來源檔內容的 sha256 前 16 碼…",
  "pinned": true,
  "force": true,
  "supersedes": "alpha-cache-key-format",
  "superseded": true
}
```

| 欄位 | 說明 |
|---|---|
| `id` | slug（kebab-case）。題目用 slug 參照，harness 再換成 server 的數字 id，重跑不會因 id 變動而壞。 |
| `project` | `alpha`／`beta`／`gamma`；`scope: "global"` 的卡不帶 `project`。 |
| `kind` | `fact`／`decision`／`pitfall`／`preference`。 |
| `pinned` | 灌入後呼叫 `POST /memories/:id/pin`。 |
| `force` | 用 `force: true` 造近似重複卡（跳過去重）。 |
| `supersedes` | 新卡取代舊卡（舊卡被軟刪除）；舊卡必須**排在前面**。 |
| `superseded` | 只標記「這張是舊版」，給驗證與 `forbidden_ids` 用的註記（server 不看）。 |

### 2.2 載入配方

1. 每次執行都建立全新的暫存 `MNEMOSHELF_DATA_DIR`（`mkdtemp`），跑完刪除（`--keep` 例外）
   → **冪等**，不會污染使用者 DB，也不需要「先刪測試資料」。
2. 依檔案順序 `POST /memories`（`content`／`kind`／`scope`／`project`／`agent: "eval-d3"`）。
3. 舊卡先建立，新卡帶 `supersedes: <舊卡 id>`。
4. `pinned` 卡再打 `POST /memories/:id/pin`。
5. 近似重複卡帶 `force: true`。

若 `POST /memories` 回 `redacted: true`（寫入前遮罩改寫內容），harness 會把卡號記進報告的
`readiness.maskIssues`——這代表 fixture 踩到機密規則，應該修 fixture，不是忽略。

### 2.3 `questions.json`

```json
{
  "id": "q001",
  "project": "alpha",
  "category": "single",
  "split": "dev",
  "lang": "zh",
  "query": "arc 的建置快取放在哪個目錄？要清掉快取該用什麼指令？",
  "expected_ids": ["alpha-build-cache-dir"],
  "acceptable_ids": [],
  "forbidden_ids": [],
  "identifier": true,
  "code_identifier": false,
  "notes": "指令 arc cache clean"
}
```

| 類別 | 題數 | 判定 |
|---|---|---|
| `single` | 50 | `expected_ids[0]` 是否在 top-5（Recall@5）與是否 rank 1（Top-1） |
| `multi` | 20 | `expected_ids` **全部**在 top-5 才算命中 |
| `update` | 20 | 新卡在 top-5、舊卡（`forbidden_ids`）不得出現在 top-5 或注入 |
| `negative` | 15 | 應完全 0 注入 |
| `cross` | 15 | 在 A 專案問 B 專案的卡；預設範圍應 0 注入，`includeAllProjects` 時應查得到（`cross_check_id`） |

- `split: "dev" | "test"` 各 60 題；**門檻只在 dev 調**，test 只用來報告。
- `acceptable_ids`：等價／近似重複卡。注入了不算命中、也**不算 FP**。
- `identifier`／`code_identifier`：query 是否含程式標識（旗標、錯誤碼、檔名、函式名、標頭）。
  目前 identifier 41 題，其中 code identifier 34 題。
- `lang`：`zh`（100 題）／`en`（20 題），用來比較語言子集。

---

## 3. Server 怎麼被啟動、就緒閘門

- 子行程：`node packages/server/dist/scripts/serve.js`，環境變數
  `MNEMOSHELF_DATA_DIR=<temp>`、`MNEMOSHELF_TOKEN=<隨機>`、`MNEMOSHELF_PORT=<空閒埠>`、
  `MNEMOSHELF_AGENT_DISCOVERY=off`、`MNEMOSHELF_EMBED_DEVICE=cpu`、`MNEMOSHELF_MODEL_DIR=<快取>`。
  token 只存在記憶體、不寫進報告。
- 服務只綁 `127.0.0.1`；harness 從 server 印出的網址取得實際埠。
- **就緒閘門**：灌完卡後輪詢 `GET /diagnostics`，直到
  `memories.pending === 0 && memories.failed === 0 && memories.stale === 0` 才開始計分。
  - `degraded: false` **不是**閘門：只要有一張 ready 就可能 false。
  - `tooLong`（`input-too-long`，永久失敗）不中止，但報告會列出；這些卡語意路徑永久不可召回，
    只能靠關鍵字補位。
  - 超過 `--readiness-timeout-min` 就中止並回非 0，**不會**用 FTS 降級數據下結論。
- 任何一題的回應出現 `degraded: true` 就標成 `degraded` 並**從所有聚合剔除**（報告 §2 會列數量）。
- 灌完資料後另外記錄外掛的 `skipReason` 分佈（報告 §2.1）；production 口徑用它決定哪些題目
  算「0 注入」。這是 F1 修正的重點：沒有套 skip 的 abstention 不是生產環境的 abstention。

---

## 4. 指標定義

### 4.1 兩種口徑（F1）

評估同時報兩種口徑，**不要只看其中一個**：

| 口徑 | 意思 | 用在哪裡 |
|---|---|---|
| **retrieval** | 假設每一題都會觸發召回；把 `planRecall` 的結果全部算進去。 | 看檢索器／裝箱的**上限**，用來定位「找不到」還是「裝不進去」。 |
| **production** | 先用外掛真正的 `skipReason`（空字串／slash／少於 6 字／幾乎全程式碼）判斷；被跳過的題目算 **0 注入**（外掛根本沒查 server）。 | 生產環境的**誤注入率與 abstention** 要讀這個；負向題常是短句，會被 skip，retrieval 口徑會高估誤注入。 |

- production 口徑的 Recall@5 欄位仍標成「檢索」：那是模型層的實測值，被 skip 的題目不是「找不到」，
  而是「根本沒查」。注入層的召回請看 `hitItems`（expected 卡實際被注入的數量）與
  `expectedHitRate`（至少一張 expected 被注入的題目比例）。
- trigger 只以「第一輪」計（`first-turn` 會召回）；真實 session 中非第一輪又沒有明示線索的訊息
  還可能被 trigger 跳過，本評估沒有把那一層算進去（見 §7 限制）。

### 4.2 指標

| 指標 | 定義 |
|---|---|
| **Recall@5** | `single`：expected 在 retrieval top-5；`multi`：**所有** required 都在 top-5。分母是 `single + multi`。 |
| **Top-1** | `single` 題中 retrieval rank 1 就是 expected 的比例。 |
| **MRR** | `single + multi`：第一個 expected 的 `1/rank`（只看前 10 名；0 表示沒找到）。 |
| **更新命中** | `update` 題中新卡在 top-5 的比例。 |
| **stale-hit** | `update` 題中舊卡出現在 retrieval top-5 的比例（舊卡已被軟刪除，結構上應為 0）。 |
| **FP 注入率** | 注入的卡中，**被標為錯誤**的比例（分母是**所有注入卡**）：`forbidden_ids`（過時／跨專案）＋ `negative`／`cross` 題的任何注入。未標註的卡不算 FP（見下方說明）。 |
| **negative 注入率** | `negative` 題中至少注入 1 張卡的比例。 |
| **cross 注入率** | `cross` 題（預設 `project` 範圍）中至少注入 1 張卡的比例。 |
| **abstention** | `negative + cross` 中完全 0 注入的比例。 |
| **空召回率** | 全部題目中 0 注入的比例。 |
| **注入量** | 每次注入的 `<memory-context>` 筆數／字元數／估算 token 的 mean／p50／p95／max。 |
| **估算 token** | CJK（含全形標點）每字 1 token、其餘 4 字元 1 token。**是估算**，沒有引入 tokenizer 依賴；只看相對比較。 |
| **延遲** | `POST /memories/search` 端到端（client 量測），分「索引閒置」與「索引進行中」兩欄；量測時 timeout 放寬到 3000ms，避免把慢查詢記成失敗，再從分佈推算 150／300ms 會 fail-open 的比例。 |
| **hitItems** | 期望卡**實際被注入**的數量（注入層召回）；`expectedHitRate` 是至少一張 expected 被注入的題目比例。 |
| **skip 題數** | production 口徑下被 `skipReason` 跳過的題目數（依原因分類見報告 §2.1）。 |
| **degraded 樣本數** | 回應 `degraded:true` 的檢索樣本數；這些題目**整筆剔除**（不計入召回／FP），報告會列出實際筆數（應為 0）。 |
| **去重命中** | variant D：被 session 去重表擋掉的候選數（TTL 8 輪）。 |
| **foreign 注入** | 注入的卡屬於「非本專案且非 global」的數量（跨專案洩漏）。 |

判定一律用 `expected_ids`／`acceptable_ids`／`forbidden_ids`，**不用分數門檻反推**：
keyword 命中的 `score` 是 `1/rank`，不是 cosine。

### 為什麼「未標註」不算 FP

標註是**稀疏**的：每題只標「必要」與「明確錯誤」的卡，其餘卡片是**未判定（unjudged）**，
不是「不相關」。例如問「快取 key 怎麼算」時，注入「快取目錄在哪」是相關背景，不是錯誤召回。
因此：

- `forbidden_ids` 與「應該 0 注入的 negative／cross 題」才算 FP；
- 其他注入卡只進 `unlabeledItems` 與「標註精準率下限」兩個欄位，**不列入 FP**；
- 若把未標註一律當 FP，單目標題（1 張 expected、注入 4 張）的下限就是 75%，數字會失去意義。

這個選擇會讓 FP 與「negative／cross 注入率」高度重疊，是刻意的：v1 的通過線本來就把
「不該注入卻注入」視為最嚴重的錯誤。

---

## 5. Variant 與為什麼這樣設計

| Variant | 設定 | 說明 |
|---|---|---|
| **A** | 無記憶 | 對照組；召回指標不適用，abstention 依定義 100%。 |
| **B** | `minScore 0.40`／`maxItems 4`／`kMax 8`／TTL 8 | D3 當時的 D2 預設（新預設見下方註記）。 |
| **C1／C2／C3** | `minScore 0.35／0.40／0.45` | C2 與 B 同設定，用來檢查同一份資料的重跑一致性。 |
| **C4–C8** | `minScore 0.50／0.55／0.60／0.65／0.70` | 延伸掃描。如果 0.35–0.45 的結果一模一樣，代表這個區間低於模型對「無關文字」的相似度下限，必須往上掃才找得到取捨點。 |
| **K3／K5／K8** | `maxItems 3／5／8` | 固定 `minScore 0.40`。 |
| **D** | B＋session 去重 TTL 8 | 以「每個專案一個 session、題目依序當輪次」模擬跨輪去重。 |
| **E** | B＋注入在開頭 | **只量 token／延遲**：字串與 B 完全相同、只是位置不同，token 必然相同；品質 A/B 需要 LLM judge，不在本卡範圍。 |
| **F** | keyword-only | 用 `minScore: 1.0` 讓 server 過濾掉所有語意命中，語意不足 k 時只剩關鍵字補位（`degraded` 仍為 false）。**不動 server**；報告會列出實際命中的 `source` 分佈，確認真的是 keyword-only。 |
| **K（kMax）** | 另跑 `k=3／5` 的檢索 | 只用來給 `kMax` 建議，不列為獨立 variant。 |
| **calib** | `k=20`、`minScore 0` | 分數尺度校準：看 expected 卡與「應該 0 注入的題目」的 cosine 分佈，判斷 minScore 是否可能分開兩者。不列為 variant。 |

> 註：本報告的 B 變體是 **D3 當時的 0.40**；D3 驗收後外掛預設已改為 **`minScore=0.65`**
> （見 `docs/opencode-plugin.md`）。本文的表格、選值規則與推薦理由保留 D3 當時的分析，
> 沒有改寫。

---

## 6. 選值規則（只出自 dev）

1. `minScore`：在 dev（production 口徑）上「FP ≤10% 且 hitItems 不低於 baseline」的候選中，
   選 abstention 最高、同分取最大的 `minScore`；若 baseline 自己**不合格**、而某個較高門檻合格且
   hitItems 不變，視為「跨過門檻」的類別差異（不套 <10pp 的噪音規則），否則差異 <10pp 一律視為
   **無法分辨**、沿用 0.40。個別指標差異的 pp 數與門檻狀態都會列在報告 §8.2。
2. `maxItems`：用**注入層**證據。`maxItems 3` 只有在「`hitItems` 不低於 4」且「token p95 降幅
   ≥10%」時才建議，否則沿用 4。Recall@5 是檢索層、與裝幾筆無關；abstention 在 minScore 0.40 下
   恆為 0，都不能當閘門。本卡沒有量下游品質，改小之前要另做品質 A/B。
3. `kMax`：`k=3／5` 若沒有以 10pp 內的差距取代 `k=8`，沿用 8（k 不是 token 成本主因）。
4. `timeoutMs`：閒置 p95 ≤150ms 且超過 150ms 比例 ≤1% → 沿用 150ms；否則把 p95 向上取到
   50ms 的倍數（上限 500ms，與外掛 clamp 一致）。索引中的排隊如實另列，不混進閒置統計。
5. 若**所有** minScore 候選都無法同時滿足 FP 與 Recall@5，報告會明說「沿用現值」——
   這通常代表問題不在門檻（例如 server 的關鍵字補位不受 minScore 約束），不是硬調參數的時機。
5. **test 只用來報告**；任何「因為 test 比較好」而改的參數都不算數。

報告的 §8 會列出每個參數的建議、是否可分辨、依據，以及可直接套用的
**D2 plugin options diff**（含 `timeoutMs`）。

---

### 報告章節導覽

| 章節 | 看什麼 |
|---|---|
| §1 摘要 | 四個問題的答案（**retrieval 與 production 並列**）、一句話結論、瓶頸判斷 |
| §2 就緒閘門 | 等多久、`pending/failed/stale/tooLong`、`degraded` 樣本數、**skip 分佈**、production 殘餘注入 |
| §3 資料集 | 題數、split、類別、identifier／語言子集 |
| §4.1–4.2 | dev：retrieval／production 兩種口徑的 variant 對照（選值只用 dev 的 production 口徑） |
| §4.3–4.4 | test：同上（只佐證） |
| §4.5–4.6 | per-category（single／multi／update／negative／cross）兩種口徑 |
| §4.7 | B 的 FP／abstention 細項（含未標註、精準率下限、hitItems） |
| §4.8 | **分數尺度**：expected 卡與「應該 0 注入」題目的 cosine 分佈、各門檻的取捨 |
| §5 | identifier／code identifier／中文／英文子集（retrieval＋production expectedHitRate） |
| §6 | 延遲（索引閒置 vs 索引中）、兩種口徑的注入量與 token 估算 |
| §7 | 跨專案題的有效性（`includeAllProjects` 能否查到）＋重跑一致性 |
| §8 | 決策規則結果、minScore 對照、D2 diff、RRF 判斷、D3b（0.70 之後的殘餘誤注入） |
| §9 | 已知限制與逐題失敗樣本 |

> 如果 §4.8 顯示 expected 卡與「應該 0 注入」題目的 cosine 大幅重疊，先別急著一直往上調
> `minScore`：先看 §8.2 的取捨（hitItems 有沒有掉）、再看 §8.5 剩下的殘餘是哪些題。

## 7. 已知限制

- **合成資料**：題目與卡片都是人工撰寫，不代表真實使用者的問法；分數不能用來宣稱產品召回率。
- **標註稀疏**：每題只標「必要」與「明確錯誤」的卡；未標註的卡不是「不相關」（見 §指標定義）。
- **maxItems 改小沒有品質證據**：本卡只量 token／召回／FP，沒有 LLM judge；要改 `maxItems` 之前先做
  下游任務的 A/B。
- **樣本量小**：每個 split 60 題，identifier 子集 41 題、中文 100 題。60 題的 Top-1 95% CI
  約 ±12–13pp；**<10pp 的差異一律當噪音**。要抓 5pp 需要 ~300 題。
- **token 是估算**：沒有引入 tokenizer；只適合相對比較與抓爆預算。
- **延遲是單機序列查詢**：CPU、空負載；「索引進行中」只跑一輪、用 6 個合成檔，不代表所有索引情境。
- **`degraded` 剔除**：若某題在檢索時 `degraded:true`，該題不列入聚合；報告會顯示剔除數。
- **沒量品質**：沒有 LLM judge、沒有下游正確率、沒有寫入品質。若召回數字好但使用者仍覺得
  「講過又忘」，下一個要查的是寫入／抽取，而不是再調 `minScore`。
- **只測 REST**：MCP 走同一條 `searchMemories`，但沒有另外量 MCP 的 transport 成本。

---

## 8. 隱私邊界

- 一律使用暫存 `MNEMOSHELF_DATA_DIR`（`mkdtemp`），**不碰**使用者的 `mnemoshelf.db`。
- 報告不含 token、不含資料目錄的絕對路徑、不含完整卡片內容（只列 slug）。
- fixtures 全部合成；`test/eval-fixtures.test.ts` 會掃 email／憑證前綴／本機絕對路徑。

---

## 9. 疑難排解

| 症狀 | 原因與處理 |
|---|---|
| `找不到 embedder 模型快取` | 先開一次 Mnemoshelf 桌面版讓它下載，或設定 `MNEMOSHELF_MODEL_DIR` 指向含 `onnx-community/embeddinggemma-2-ONNX` 的目錄。harness 不會下載模型。 |
| `就緒閘門逾時` | 看 `--verbose` 的 server log；常見是模型載入失敗（`failed` > 0）或 CPU 太慢。必要時加 `--readiness-timeout-min 30`。 |
| `F` 的 `semanticHits > 0` | 代表有 cosine 恰好 1.0 的命中（幾乎不可能），或 server 行為變了；報告的 `keywordOnlyCheck` 會顯示。 |
| `pnpm -r build` 很慢 | 手動先建置一次，之後 eval 不會重跑。 |
| 想保留 DB 檢查 | `--keep`，路徑會印在 console（不是報告裡）。 |

---

## 10. L1：規則層鎖定（`npx vitest run test/rules`）

對話記憶的**常數與規則**鎖在 vitest，不啟動 server、不呼叫模型：

```bash
cd packages/opencode-plugin && npx vitest run test/rules
```

| 檔案 | 鎖住什麼 |
|---|---|
| `test/rules/constants.test.ts` | 召回 short 門檻（`6` 字）、`MIN_DIGEST_TURN_CHARS=40`、items 上限、timeout 上下限與預設值 |
| `test/rules/incidents.test.ts` | 三次真實事故的回歸（每一條的失敗訊息都寫出「當時錯在哪」） |
| `test/rules/regression-queries.test.ts` | `eval/fixtures/regression-queries.json` 的召回回歸題 |
| `test/rules/matrix.test.ts` | 規則矩陣（觸發／跳過／預算／scope 的組合） |

前提：只要 `node_modules` 與 `src/**` 存在即可。**不要**用
`pnpm --filter … test -- test/rules` 想只跑這個目錄——vitest 會忽略該路徑過濾；
請照上面的 `npx vitest run test/rules`。

## 11. L2：對話迴圈（`eval:loop`）

假宿主（假 OpenCode `ctx`）＋**真** mnemoshelf server＋**真** embedder，跑完整 digest 迴圈與
召回注入；模型是 canned，不需要 API key。

```bash
pnpm --filter @mnemoshelf/opencode-plugin eval:loop
# 負向對照：受影響的場景應該轉紅（退出碼 1）
pnpm --filter @mnemoshelf/opencode-plugin eval:loop -- --fault model-missing
```

| 項目 | 內容 |
|---|---|
| 前提 | `packages/server` 已建置；embedder 快取存在（`MNEMOSHELF_MODEL_DIR` 可覆寫）；外掛 dist 比 src 新（過期會只重建本套件） |
| 報告 | `.tmp/eval-loop/loop-report.{json,md}`（gitignore） |
| 退出碼 | `0`＝全部硬門檻 PASS；`1`＝有硬門檻 FAIL／未執行，或環境層失敗 |

場景↔斷言對照（完整清單見 `eval/loop/README.md`）：

| 斷言 | 場景 |
|---|---|
| 1 回合卡內容與 payload | `a1.turn-cards-alpha`、`a1.turn-cards-chat`、`a1.snapshot-waterline` |
| 2 最近回合注入順序／招呼語不注入 | `a2.recent-turns-order`、`a2.greeting-not-injected` |
| 3 舊回合靠語意找回（**僅報告 INFO**） | `a3.semantic-old-turn` |
| 4 scope 隔離 | `a4.alpha-not-beta`、`a4.global-visible-alpha`、`a4.alpha-not-chat` |
| 5 召回去重 TTL | `a5.dedupe-ttl` |
| 6 fail-open（503／timeout） | `a6.fail-open-503`、`a6.fail-open-timeout` |
| 7 模型逾時（寫入前） | `a7.model-timeout-before-write` |
| 8 冪等 | `a8.idempotent-*`（5 個） |
| 9 `digest.log` 隱私 | `a9.log-privacy` |
| 負向自我檢查 | `n1.other-location-skipped`、`n2.model-unavailable-skipped` |

`INFO` 只輸出觀察值、不設門檻，**不是 PASS**，也不影響退出碼。

## 12. L3：摘要品質（`eval:digest`）

30 回合合成對話，量摘要的內容、kind、召回與延遲；預設 canned 基線完全離線。

```bash
pnpm --filter @mnemoshelf/opencode-plugin eval:digest
pnpm --filter @mnemoshelf/opencode-plugin eval:digest -- --dry-run
pnpm --filter @mnemoshelf/opencode-plugin eval:digest -- --model <id> --allow-paid
```

| 項目 | 內容 |
|---|---|
| 前提 | `packages/server` 已建置；embedder 快取存在；指定模型需在 `eval/digest/models.json` 且憑證在環境變數 |
| 報告 | `.tmp/eval-digest/digest-report.{json,md}`（gitignore） |
| 退出碼 | `0`＝硬條件全過＋parity 一致＋沒有 degraded 召回；`1`＝NOT RUN／硬條件 FAIL／parity 不一致／前置失敗 |
| 硬條件 | `mustNotInclude=0`、跨專案洩漏=0、`45000ms ≥ 2×p95` |
| 軟門檻 | mustInclude 90%、kind 80%、端到端召回 90%——只標 `INFO`，不影響退出碼 |

端到端召回口徑：期望內容被 server 召回**且**實際注入 `<memory-context>`（不區分來源卡別）。
`rejected` 是被 parser 丟棄的 item 數，parse 錯誤另計。詳見 `eval/digest/README.md`。

環境變數（只有 L3 真模型會用到；名稱如下，值不寫進 repo）：
`MNEMOSHELF_EVAL_MODEL_URL`、`MNEMOSHELF_EVAL_MODEL_KEY`（`models.json` 的範例項）。

## 13. matrix：三模型同條件比較（`eval:digest:matrix`）

同一份 fixture、同一條管線跑多個摘要模型，產出排行榜；預設 screening 前 10 回合。

```bash
pnpm --filter @mnemoshelf/opencode-plugin eval:digest:matrix -- --models all
pnpm --filter @mnemoshelf/opencode-plugin eval:digest:matrix -- --models all --turns all
pnpm --filter @mnemoshelf/opencode-plugin eval:digest:matrix -- --models all --dry-run
```

| 項目 | 內容 |
|---|---|
| 模型設定 | `eval/digest/matrix-models.json`（eval 專屬；只有環境變數名稱） |
| 報告 | `.tmp/eval-digest-matrix/matrix-report.{json,md}`（gitignore） |
| 退出碼 | `0`＝每個模型都 `RANKED` 且五條硬門檻全過；`1`＝任何模型 NOT RUN／ERROR／硬門檻 FAIL，或估算超過 `--max-calls` |
| 成本保護 | 預設 10 回合；付費模型要 `--allow-paid`；`--dry-run` 不發請求；`--max-calls` 預設 100 |

五條硬門檻：`mustNotInclude=0`、跨專案洩漏=0、JSON 成功率 ≥95%、
p95 ≤ 該模型 `timeoutMs/2`、p95 ≤ 30000ms（絕對上限）。
環境變數（名稱）：`MNEMOSHELF_EVAL_OPENCODE_URL`、`MNEMOSHELF_EVAL_OPENCODE_PASSWORD`、
`MNEMOSHELF_EVAL_OPENCODE_USERNAME`、`MNEMOSHELF_EVAL_OPENROUTER_API_KEY`。
缺少時該模型標 `NOT RUN`（非零退出），不改走其他供應商繞路。

矩陣報告另有 S6 spike（OpenCode `/api/experimental/generate` 的認證、schema、錯誤碼、延遲）
與「硬條件鑑別力」表：canned 基線下哪些 PASS 只是結構性成立。
