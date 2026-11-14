# 原文記憶與遮罩設定

> **讀者**：設定 Agent 自動記憶的使用者，以及接入 REST／MCP 的開發者。
> **一句話**：保存可見對話原文，以程式切塊與既有 embedding 召回，不需要摘要模型。
> **現在要做**：在 App 選擇記憶遮罩政策，再依宿主外掛指引啟用原文擷取。
> **依據**：本專案記憶儲存、來源服務與 Agent 外掛契約。

## 保存什麼

一個來源代表一個完成的回合，包含有序的使用者與助理文字、訊息識別及角色。原始時間未知時為 `null`；接收時間另存，不冒充對話時間。不包含 system 指令、隱藏推理、工具輸出、附件或 Mnemoshelf 再次注入的記憶。

原文不經生成模型改寫。服務先依遮罩政策處理完整訊息，再按段落與長度切塊；既有 embedding 模型對片段建立索引。保存成功與索引完成是不同狀態：模型暫時不可用時，來源仍可讀取。

「完整」指宿主在擷取事件提供的可見文字。舊摘要及曾被截短的卡片無法還原成完整對話；升級保留它們並標成舊版記憶。Codex 可選擇啟用 `Stop` 原文擷取：只保存該次事件指定的回合，不回填舊對話；支援的 transcript 格式與離線限制見 [Codex 接入指引](codex-recall.md)。

## App 的遮罩開關

設定頁的「自動遮罩記憶中的機密」預設開啟，同一資料目錄的所有 Agent 共用服務保存的值。

| 操作 | 開啟 | 關閉 |
| --- | --- | --- |
| 新增、編輯、匯入記憶 | 先遮罩再保存 | 保存接收的文字 |
| 列表、召回、來源展開、匯出 | 回傳前再遮罩，包括先前關閉時保存的內容 | 回傳已保存的內容 |
| 切換政策 | 不批次改寫既有來源或向量 | 不能還原已被遮罩的文字 |

設定只控制**記憶內容**。檔案索引的遮罩、metadata 驗證、連線 token 與診斷處理仍按原規則。可辨識的機密格式見 [隱私契約](roots-and-privacy.md)；遮罩可能誤判或漏判。

開啟遮罩不等於清除資料庫中的舊明文，也不能追回已送給 Agent 的上下文或自行下載的備份。服務仍是本機單一 owner：持有同一 token 的程式可讀寫全部記憶，`agent` 與 `scope` 不構成多使用者權限隔離。

```http
GET /memory-policy
PATCH /memory-policy
Content-Type: application/json

{"maskSecrets":true}
```

兩者成功均回 `{ "maskSecrets": true, "version": 1 }` 形狀的有效值。只有實際更動才增加版本；保存失敗回錯誤，不假回成功。新端點沿用既有 Bearer token 驗證。

## 原文寫入 API

`POST /memory-sources` 接受完整回合。下面是合成範例：

```json
{
  "agent": "example/turn",
  "scope": "project",
  "project": "demo-project",
  "sourceSession": "session-example",
  "sourceTurn": "turn-example",
  "messages": [
    {
      "sourceMessage": "message-user",
      "role": "user",
      "content": "測試資料要保留哪些欄位？",
      "occurredAt": null
    },
    {
      "sourceMessage": "message-assistant",
      "role": "assistant",
      "content": "保留角色、順序與原始文字。",
      "occurredAt": null
    }
  ]
}
```

成功回來源 metadata、`memoryIds`、`saved:true`、`duplicate`、`policyVersion` 及遮罩計數，不回整份原文。`saved` 表示來源與片段已保存，不表示向量 ready。

| 情境 | HTTP 結果 |
| --- | --- |
| 新事件完整保存 | 201 |
| 相同 agent／session／turn、相同原始請求重送 | 200，`duplicate:true` |
| 相同事件識別但內容不同，或事件已刪除 | 409，不覆寫、不復活 |
| 非法角色、metadata、時間、重複訊息 ID | 400，不保存半個回合 |
| JSON body 超過 8 MiB | 413，不截短後保存 |

內容保留空白、換行及合法 Unicode。含 NUL 或未配對 UTF-16 surrogate 時明確拒絕，避免不同資料庫靜默替換文字。metadata 沿用 200 字元與 token-like 驗證；原始訊息時間不知道就傳 `null`。

相同文字發生在不同事件會各自保存。內容更正應使用新的事件 ID；原文來源不走舊短記憶的 `supersedes` 編輯。手動 `POST /memories`／MCP `remember` 仍可保存 Agent 主動整理的短記憶，其 8,000 字元上限與既有去重語意保留。

## 搜尋與繼續讀取

`POST /memories/search` 及 MCP `search_memories` 沿用專案／scope 過濾，先過濾再排名。原文檢索仍以語意優先、關鍵字補位；各排名路徑最多作一次保守的來源互補：高順位來源只命中一則訊息時，可由既有候選池補入同來源另一則訊息，替換尾端較弱來源的次要重複片段，保留候選總數、原分數及其餘相對順序。這避免提問命中卻漏掉同回合回答，舊記憶單獨檢索的排序不變。

原文命中附來源 ID、角色、原始時間與片段位置；助理原文不因舊分類欄位為 `fact` 而成為客觀事實。自動注入有呈現預算，片段不是整場對話。

原文節錄附 `snippetStart`／`snippetEnd`（保存文字座標）；選用 `snippetAnchor` 是回傳文字內的 UTF-16 相對位置，供接入端在更小預算中保留重點，不能當來源分頁游標。遮罩造成長度變動時會映射位置。兩外掛按來源分組，每組最多兩個不同角色或位置的片段，共用有限注入預算，避免只保留使用者提問而丟掉同回合助理回答。

需要更多內容時用 `GET /memory-sources/:id` 或 MCP `read_memory_source`。查詢必須提供明確範圍，例如 `project=demo-project`；明確 `scope=global` 只讀 global，`scope=agent` 需帶 agent。來源不存在、已刪除或不符合範圍時回 404，不接受任意檔案路徑。

來源回應包含：

- `source`：來源識別、範圍、接收時間與切塊版本。
- `messages`：角色、訊息識別、原始時間、文字及本頁範圍。
- `indexState`：total、pending、ready、failed、tooLong、stale。
- `next`：下一頁的 messageIndex、offset、policyVersion；讀完為 null。
- `truncated`、`policyVersion`、`untrusted:true`。

`maxChars` 預設 8,000、上限 32,000。續讀帶回 `next` 的全部值；政策版本變動回 409，從頭讀取，不能把遮罩前後不同視圖拼接。分頁 offset 對顯示文字計算；搜尋的 sourceStart／sourceEnd 對保存文字計算，兩者不能互換。

遮罩先處理完整來源訊息，再將保存位置映射到安全文字範圍。即使機密跨越 chunk 邊界，也不靠單獨遮罩半段文字來處理。

## 來源的生命週期

來源文字與可重建的檢索片段分開保存。初始切塊版本為 `raw-v1`：每段最多 1,024 UTF-16 字元、重疊 128，優先段落／換行，不拆開 emoji surrogate pair。換 embedding 模型會將舊向量判定為 stale 並重新嵌入。

App 對原文卡的共享、釘選與刪除，皆作用於**整個原文回合**。既有 `/memories/:id` 操作若指向原文片段，服務也會同步整來源，避免只刪一片而留下其他可召回副本。原文卡不提供短記憶編輯按鈕。

軟刪除保留歷史文字但不再召回；硬刪除移除來源、片段、全文索引與向量，僅保留事件識別的不可逆 hash，防止舊 spool 重送而復活。硬刪除不保證 WAL／檔案系統的取證級抹除。

## 備份與舊資料

`GET /memories/export` 預設輸出 schemaVersion 2 NDJSON：短記憶為 `type:"memory"`，原文回合為 `type:"source"`；不將每個檢索片段重複匯出。原文行保存完整有序訊息與角色，不含向量、內部 requestHash 或已刪歷史。

原文來源列另以 `pinned` 布林欄位保存整回合的釘選狀態，還原時同步所有重建片段。
舊 v2 備份未帶此欄位時預設未釘選；帶有非布林值時整批拒絕。dry-run 不更動釘選，
重複來源的匯入也不覆寫資料庫現有的釘選選擇。

匯出依當下有效遮罩政策產生。匯入重新切塊與嵌入，保留來源事件及訊息原始時間，資料庫數字 ID 重新配置。相同備份重送可去重；與現有事件衝突則明確回報，不能默默覆寫。空庫還原是完整備份的基本使用方式。

舊版 v1 NDJSON 仍可匯入。`?schemaVersion=1` 只在沒有有效原文來源時可匯出；有原文來源回 409，避免舊格式備份默默漏資料。新 v2 格式會被不支援的舊服務拒絕，升級前備份應搭配相容版本還原。

匯入上限仍為 32 MiB，先驗證整批，dry-run 與實際匯入採同一驗證規則。超過上限的匯出檔可保存，但不能宣稱可直接由單一匯入請求還原；本版沒有串流備份協定。

## 宿主升級與離線補送

OpenCode 原先未啟用自動寫入者，升級後仍維持關閉；原先啟用 digest 者改為原文擷取，不再需要 `digestModel` 或額外生成呼叫。dsh 延續既有寫入選擇。安裝與實際設定名稱分別見 [OpenCode 指引](opencode-plugin.md) 和 [dsh 說明](../packages/dsh-plugin/README.md)。

離線 spool 保存固定事件 payload。遮罩為開或無法取得可靠政策時，先遮罩完整訊息再落地；關閉時可保存原文。第一次送出與重試使用同一 payload，服務在接收時仍依有效政策處理。切換不批次改舊 spool，已遮內容無法還原。

宿主重發同事件但 prepared payload 已改變時，服務可能回 409；外掛不得悄悄改事件 ID 來製造副本。舊版服務不支援來源 API 時，明示升級與待補送，不退回截短卡片，也不把 HTML 或未知回應當作成功。

## 已量測的效果與限制

以凍結的合成題庫評測：30 題調參、130 題保留集（112 題可答、18 題無答案）。使用既有 EmbeddingGemma 2 q4／CPU，兩外掛取相同 k=8 候選，以舊截斷卡作對照。下列是「完整必要證據進入注入區塊」的題數，不是回答模型的正確率。

| 條件 | 舊截斷卡 | 原文流程（兩外掛） |
| --- | ---: | ---: |
| 語意搜尋，900 Unicode 碼點 | 108／112 | 112／112 |
| 語意搜尋，384 EmbeddingGemma tokens | 108／112 | 109／112 |
| 語意搜尋，192 EmbeddingGemma tokens | 70／112 | 63／112 |
| 關鍵字降級，900 Unicode 碼點 | 107／112 | 103／112 |

四個長回合中段／尾段反例都完整命中。原文保存避免了舊卡片的截斷，但很小的上下文預算與純關鍵字排序仍有退步；不能推論原文在所有條件下都優於摘要或卡片。模型 token 數取自 embedding tokenizer，實際回答模型另計；回答與拒答品質尚未評測。

Apple M2／16 GB、小型隔離 SQLite 語料的暖機查詢 p95 約 58 ms，包含 HTTP、政策檢查與外掛封裝，不含宿主 UI、OpenCode 最近回合附加請求或回答模型。這不是其他平台或大資料庫的效能保證。重跑方式、固定題庫與逐題輸出格式見 [原文評測工具](../packages/server/eval/raw-memory/README.md)。
