# L3：摘要品質量測（`eval:digest`）與三模型矩陣（`eval:digest:matrix`）

用 30 回合的**合成**對話量「摘要寫得好不好」：該記的記到沒有、不該記的有沒有混進來、
kind 對不對、來得及在逾時內完成嗎、寫進去的東西之後找不找得回來。

管線沿用 L2 的假宿主與真 server（`eval/loop/{host,server}.mjs`，唯讀重用）：

```
resolveDigestTurn → buildDigestPrompt → 模型 → parseDigestItems
→ buildDigestCards → writeDigestMemory → follow-up 召回（真 embedder）
```

`buildDigestCards()` 是產品碼（`src/digest.ts`）匯出的純函式；runtime 的 POST 內容會與它的
輸出逐位元比對（parity），所以本 harness 量到的卡片就是產品實際送出的卡片。

## 前提

| 項目 | 需求 |
|---|---|
| Node | 22 以上（與 repo 相同） |
| pnpm | 10 |
| server 建置 | `packages/server/dist/scripts/serve.js` **必須先存在**（`pnpm --filter @mnemoshelf/server build`）。harness 不會自動建置 server；找不到就直接失敗。 |
| 外掛 dist | 需比 `src/**/*.ts` 新。harness 會逐一比對 mtime；過期只重建 `@mnemoshelf/opencode-plugin`（**不跑 `pnpm -r build`**），重建失敗就明確失敗，不會靜默測舊碼。 |
| embedder 快取 | **必須已存在**，harness **不下載**。依序找 `MNEMOSHELF_MODEL_DIR`、`~/.config/Mnemoshelf/models`、`~/.local/share/mnemoshelf/models`、`~/Library/Application Support/Mnemoshelf/models`、`<repo>/.tmp/speed-diagnosis/models`；需要 `onnx-community/embeddinggemma-2-ONNX/onnx/model_q4.onnx`。找不到就明確失敗。 |
| 網路 | `eval:digest` 預設 canned 基線完全離線；真模型才需要端點（`models.json`）與對應環境變數。 |
| 模型 | 指定不存在的 `--model`、模型被停用、缺少憑證 → 標 `NOT RUN` 並以非零退出，不會靜默跳過。 |

## 執行（單模型）

```bash
# 完全離線、零成本（canned 抽取式基線；預設）
pnpm --filter @mnemoshelf/opencode-plugin eval:digest

# 只看會呼叫幾次模型（不呼叫、不啟動 server、不寫報告）
pnpm --filter @mnemoshelf/opencode-plugin eval:digest -- --dry-run

# 成本保護（預設 100 次；超過直接中止）
pnpm --filter @mnemoshelf/opencode-plugin eval:digest -- --max-calls 100

# 真模型（需先在 models.json 設好端點與環境變數；付費模型要 --allow-paid）
pnpm --filter @mnemoshelf/opencode-plugin eval:digest -- --model <id> --allow-paid
```

pnpm 10 會把 `--` 原樣傳給 script；runner 會忽略它，並支援 `--flag value` 與 `--flag=value`。

`--dry-run` 的「預計模型呼叫」＝不會被跳過的回合數（本 fixture 為 27）；「預計召回查詢」＝
**同時**有 `recallQuery` 與 `recallMarker` 的回合數（本 fixture 為 **16**）——只有 `recallQuery`、
沒有 marker 的回合無法判定命中，所以不會做搜尋。

## 退出碼

- **0**：所有硬條件 PASS、卡片 parity 一致、召回沒有 `degraded`、回合數符合 fixture。
- **1**：前置失敗（缺 server 建置／embedder 快取／dist 重建失敗）、模型 `NOT RUN`、
  任何硬條件 FAIL、parity 不一致、`degraded` 召回大於 0，或 `--dry-run` 的估算超過
  `--max-calls`。

軟門檻（`mustInclude`／kind／端到端召回）只報告、標 `INFO`，**不影響退出碼**；
`INFO` 不等於 PASS，未達標會寫「未達標，待校準」。

## 指標與門檻

比對規則寫死在 `lib/text.mjs`：NFKC（全形轉半形）→ 小寫 → 去空白，之後做子字串比對；
針正規化後不足 4 字元視為 fixture 錯誤。

**硬條件（影響退出碼）**

- `mustNotInclude` 命中 = 0
- 跨專案洩漏 = 0（內容層：其他專案標記出現在本專案輸出；scope 層：從其他專案召回／列出時看得到）
- `digestTimeoutMs`（production 45000ms）≥ 2 × 模型呼叫延遲 p95

**軟門檻（只報告，標 `INFO`，不影響退出碼）**

- `mustInclude` 通過率 ≥ 90%
- kind 命中率 ≥ 80%
- 端到端召回 ≥ 90%

**端到端召回口徑**：server 查詢命中 `recallMarker` **且**實際注入的 `<memory-context>` 含同一
marker。注入塊不標 agent，marker 也可能同時出現在原子 item 與回合卡，所以本口徑是
「期望內容被召回**且**實際注入」，**不區分**來源卡別。

未達標會標「未達標，待校準」；不得為了讓數字好看而改門檻或改 fixture 期望值。

另外記錄「items 原始數 vs parser 保留數」（`parseDigestItems` 超限是 `break`，不能靠
`rejected` 反推）。報告裡的 `rejected` 是**被 parser 丟棄的 item 數**（quote 不實、形狀不符等），
parse 錯誤（`not-json`／`shape`）是**失敗回合**，兩者分開記。

## 報告

輸出到 `.tmp/eval-digest/digest-report.{json,md}`（已被 `.gitignore` 忽略），內容含模型、
fixture 版本與指紋、git HEAD＋dirty、延遲 p50/p95、token／成本（沒有 usage 就 `N/A`）、
各項指標與逐回合明細。報告不含金鑰、sessionID 明文、對話全文或本機絕對路徑。

## 矩陣：三模型同條件比較（`eval:digest:matrix`）

用**同一份 fixture、同一條管線**跑多個摘要模型，產出排行榜。模型設定在
`matrix-models.json`（**eval 專屬**，不是產品設定格式）。

```bash
# 預設 screening 前 10 回合（成本保護）
pnpm --filter @mnemoshelf/opencode-plugin eval:digest:matrix -- --models all

# 完整 30 回合（會呼叫更多次模型）
pnpm --filter @mnemoshelf/opencode-plugin eval:digest:matrix -- --models all --turns all

# 只估算、不發任何請求（含環境變數與 NOT RUN 原因）
pnpm --filter @mnemoshelf/opencode-plugin eval:digest:matrix -- --models all --dry-run

# 單一模型（逗號分隔可選多個）
pnpm --filter @mnemoshelf/opencode-plugin eval:digest:matrix -- --models deepseek-v4.1-flash
```

| 參數 | 預設 | 說明 |
|---|---|---|
| `--models <all\|id,id>` | `all` | 要跑哪些模型 |
| `--turns <10\|N\|all>` | `10` | 篩選回合數；`all`＝完整 30 回合 |
| `--dry-run` | 關 | 只印環境狀態與呼叫估算，不發請求、不啟動 server、不寫報告 |
| `--max-calls N` | `100` | 跨模型的模型呼叫上限；估算超限會在送出任何**模型**請求前中止（`opencode` transport 仍可能先做一次唯讀 `GET /openapi.json` 探測：不呼叫模型、不計費） |
| `--allow-paid` | 關 | 付費模型（OpenRouter）必須顯式開啟才會被呼叫 |
| `--out DIR` | `<repo>/.tmp/eval-digest-matrix` | 報告目錄 |
| `--no-build` | 關 | dist 過期時直接失敗，不自動重建 |
| `--keep` | 關 | 保留暫存資料目錄（除錯用；路徑不寫進報告） |
| `--verbose` | 關 | 印出暫存 server 的 log |

### 模型與 transport

| 模型 | transport | `digestModel` | 需要的環境變數（名稱） |
|---|---|---|---|
| DeepSeek V4.1 Flash | `opencode` | `opencode-go/deepseek-v4.1-flash` | `MNEMOSHELF_EVAL_OPENCODE_URL`、`MNEMOSHELF_EVAL_OPENCODE_PASSWORD`（選用 `MNEMOSHELF_EVAL_OPENCODE_USERNAME`） |
| Qwen 3.7 Flash | `openai` | `openrouter/qwen/qwen3.7-flash` | `MNEMOSHELF_EVAL_OPENROUTER_API_KEY` |
| Scaledown Summarize | `openai` | `openrouter/scaledown/summarize` | `MNEMOSHELF_EVAL_OPENROUTER_API_KEY` |

- `openai` → `POST {baseUrl}/chat/completions`，`temperature: 0`、帶 `max_tokens`。
- `opencode` → `POST {serverUrl}/api/experimental/generate`，body
  `{ prompt, model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } }`。
  認證是 HTTP Basic：username 預設 `opencode`，password 是**該 OpenCode server 行程**的
  `OPENCODE_SERVER_PASSWORD`（模型供應商的 key 由 server 端持有，不進 eval）。
- **埠與密碼不是固定值**：spike 當時可用的埠、以及每個 OpenCode server 行程的
  `OPENCODE_SERVER_PASSWORD` 都不一樣，會隨行程重啟而變。請用**當下**行程的資訊
  （例如從該行程的環境變數取得），不要假設 spike 記錄的埠或密碼可以沿用。
- 模型憑證只能從環境變數讀；`matrix-models.json` 只放**變數名稱**。

### 硬門檻（五條，各自獨立）

- `mustNotInclude` 命中 = 0
- 跨專案洩漏 = 0（內容層＋scope 層）
- JSON 成功率 ≥ 95%（分母＝真的有呼叫模型的回合；`not-json`／`shape` 都算失敗）
- p95 ≤ **該模型** `timeoutMs / 2`
- p95 ≤ **30000ms**（絕對上限，避免把 `timeoutMs` 調寬就過關）

報告會同時列「vs 該模型 timeout」與「vs production 45000ms」兩條預算，**不混用**。
其他指標（turn 非空率、rejected items、mustInclude、kind、卡片寫入、端到端召回、
延遲、逾時率、token／成本、API 錯誤分類）只報告，不影響退出碼。

### NOT RUN 與退出碼

- 缺環境變數、OpenCode server 探測失敗（401／404／連不上）、付費模型沒有 `--allow-paid`
  → 該模型標 **`NOT RUN`**，**不呼叫模型**，其他模型照跑。
- 只要有任何模型 `NOT RUN`／`ERROR`／硬門檻 FAIL → **退出碼 1**；三個模型全 `NOT RUN`
  也是 1。全部 `RANKED` 且五條硬門檻全過才是 0。
- `opencode` 的 spike 失敗處理：**不改走 OpenRouter 繞路**，就照 `NOT RUN` 如實記錄。

### 報告

`<repo>/.tmp/eval-digest-matrix/matrix-report.{json,md}`，內含：

- 排行榜（每個模型的 JSON 成功率、mustInclude／mustNotInclude、kind、卡片寫入／召回／
  內容命中、p50／p95、逾時率、token／成本、API 錯誤分類）
- 逐模型的五條硬門檻 PASS／FAIL 與逐回合明細
  （`mustNotInclude`／跨專案命中只記**回合 id**，不存 needle 或模型輸出文字）
- S6 spike 結論（端點、認證方式、request／response schema、錯誤碼、延遲、用哪個埠）
  與本輪的唯讀探測結果
- 硬條件的**鑑別力**標註：哪些條件在 canned 基線下只是「結構性成立」
- 成本保護（估算、實際呼叫數、`--max-calls`、`--allow-paid`）

報告不含 prompt、對話全文、金鑰、server URL 或本機絕對路徑。

## 與程式碼的關係

- 量測數字只代表「這個模型 × 這個 fixture 版本 × 這個回合範圍」；預設的 canned 基線**不代表**
  真實模型品質，只用來證明管線、量測規則與成本保護可重跑。
- 產品碼只改 `src/digest.ts` 的組卡抽取；召回行為、設定鍵與寫入順序都不變。
- 矩陣的 `transport` 只在 eval 內模擬「宿主把 prompt 送到模型」，不新增產品設定格式；
  宿主 `ctx.model.list()` 的驗證仍走 harness 的 `canned/digest-model`，矩陣的 `digestModel`
  是**被轉送的目標模型標籤**。
