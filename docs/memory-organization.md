# 記憶整理與召回規則

> **讀者**：整理記憶的使用者，以及接入 REST／MCP 的開發者。
> **一句話**：來源、歸屬與召回用途分開保存，規則預設只影響之後寫入。
> **現在要做**：先用完整清單整理，再在召回規則頁預覽影響範圍。
> **依據**：MetadataStore、管理與召回 API、schemaVersion 3 備份契約。

記憶管理分成「記憶清單」、「召回預覽」與「召回規則」。清單用於整理完整記憶庫；
召回預覽用指定專案與 agent 標記試查；規則決定新記憶能在哪些情境被使用。
這些設定是本機單一 owner 的使用偏好，並非多使用者權限隔離。

## 來源、歸屬與用途

| 資訊 | 欄位 | 意義 |
| --- | --- | --- |
| 來源專案 | `originProject` | 首次寫入時提供的專案，之後不可更改。無法得知時為 `null`。 |
| 歸屬專案 | `assignedProject` | 用來分類與套用專案規則的專案，可整理或清除。 |
| 寫入者 | `agent` | 寫入端提供的來源標記，不是登入身分，之後不可更改。 |
| 召回用途 | `recallPolicy` | `project`、`global`、`agent` 或 `disabled`。 |
| 用途依據 | `recallPolicySource` | 舊資料 `legacy`、寫入預設 `default`、規則 `rule` 或單筆例外 `override`。 |
| 規則快照 | `recallRuleId`、`recallRuleRevision` | 記錄套用時的規則及修訂；規則刪除後仍保留歷史依據。 |

`project` 只在指定歸屬專案使用；`global` 可跨專案使用；`agent` 需要呼叫端提供相同 agent 標記；
`disabled` 保留內容供管理，但不納入召回。若規則指定 `project` 而資料沒有歸屬專案，結果為
`disabled`，不會自動擴大為全域使用。

升級既有資料時，歸屬沿用舊 `project`，用途沿用舊 `scope`，依據為 `legacy`。
舊欄位不能證明最初的來源，所以 `originProject` 一律保留未知，不從 session 或目錄名稱猜填。
升級不刪除記憶內容，也不重建既有 ID、原文、向量、編輯版本關係或刪除事件記錄。

舊 `scope`／`project` 是相容介面的投影。將用途改成跨專案或同寫入者使用，不清除來源與歸屬。
舊 `PATCH /memories/:id` 的範圍更新會成為單筆例外；指定 `scope: "project"` 及 `project`
時也更正歸屬。管理與新接入端應讀組織欄位，不能由 `project: null` 推論「全域」。

## 完整記憶庫查詢

`GET /memory-library` 接受以下 AND 條件，全部在資料庫中篩選後才分頁：

| 參數 | 語意 |
| --- | --- |
| `project` | 歸屬專案完全相同；省略表示全部。 |
| `unassigned=true` | 只取未指定歸屬者，不能同時指定 `project`。 |
| `writer` | 寫入者完全相同，跨所有用途比對。 |
| `type` | `source` 原文回合或 `memory` 短記憶；省略表示全部。 |
| `query` | 內容包含文字，區分大小寫，`%`／`_` 按字面比對。 |
| `limit` | 預設 25，上限 100。 |
| `cursor` | 前一頁的 `nextCursor`；篩選改變後須回到第一頁。 |

回應的 `entries` 是管理項目，原文先聚合成回合，再排序與分頁。任一片段命中內容查詢，
該回合只出現一次。每項有 `type`、`id`、`memory` 代表列與 `chunkCount`；來源 ID 與短記憶 ID
是不同命名空間。`total`、`counts.sources`、`counts.memories` 是完整符合條件數，
`facets.projects`／`writers`／`hasUnassigned` 來自完整未刪記憶庫，不從當頁推算。

排序依序為釘選優先、建立時間新到舊、類型、ID；游標綁定篩選條件。資料或釘選改變後，
介面重新載入第一頁。每次查詢有一致的頁面與計數快照；跨多次翻頁並非鎖定整個資料庫。
舊 `GET /memories` 保留原來的管理介面與筆數上限，相容既有呼叫端。

## 規則與既有資料

規則形狀為 `{ id, project?, writer?, policy }`，至少指定專案或寫入者之一，
相同 selector 不能重複。比對歸屬專案與寫入者；優先序為：

1. 單筆例外。
2. 專案與寫入者組合規則。
3. 專案規則。
4. 寫入者規則。
5. 寫入請求的原用途。

用途在寫入時保存成快照。保存規則預設只影響之後新寫入的資料，重送已存在事件不會重套規則。
編輯短記憶建立新版本、或重新切分原文時，沿用原項目的組織與用途。

明選套用既有資料時，先預覽符合數、實際變更數與保留的單筆例外數，均分回合與短記憶計算。
只重算新 selector 命中的非例外項目，採完整規則集的優先序；來源與全部片段在同一交易更新。
修改 selector 不會追改舊 selector 的歷史資料；刪除規則也只影響未來寫入，既有用途快照保留。

`GET /memory-recall-rules` 回傳 `{ revision, dataRevision, rules }`。
`revision` 表示規則修訂；`dataRevision` 表示記憶或用途變動，與機密遮罩的 `policyVersion` 分開。

| 操作 | 請求 |
| --- | --- |
| 預覽 | `POST /memory-recall-rules/preview`，body `{ rule }`。 |
| 儲存 | `PUT /memory-recall-rules/:id`，body `{ project?, writer?, policy, expectedRevision, applyExisting?, expectedDataRevision? }`。 |
| 刪除 | `DELETE /memory-recall-rules/:id`，body `{ expectedRevision }`。 |
| 整理單項 | `PATCH /memory-library/:type/:id/organization`，body `{ assignedProject?, recallPolicy?, expectedDataRevision? }`。 |

`applyExisting` 預設為 false；true 時必須帶預覽的 `expectedDataRevision`。
規則與操作請求只接受上述欄位；未知或拼錯的欄位回 400，資料與規則維持原狀。
修訂過期回 409，應重新預覽，不能以舊計數直接確認。修改表單也會使舊預覽失效。
單項 `recallPolicy: null` 表示清除例外並重新套用目前規則；沒有規則時，有歸屬則為專案用途，
無歸屬則停用。只改歸屬時，一般項目會依新歸屬重新求值，單筆例外則保留；專案用途沒有歸屬時
仍會停用。原文的單項操作一律作用於整個回合。預覽變更數也包含用途依據或規則修訂的更新，
不代表每一項的有效用途都不同；`dataRevision` 是遞增版本，不能當成變更筆數。

## 召回入口

召回條件在排名與 LIMIT 前套用。停用資料不進入記憶向量、記憶關鍵字、通用搜尋的記憶候選，
或最近回合召回。`MemorySearchFilter.writer` 是額外 AND 篩選；`agent` bucket 則是允許同寫入者
用途的情境，兩者語意不同。

`GET /memories/recent` 提供按召回情境取最近記憶；外掛不應再以管理列表替代。
通用 `POST /search` 可帶 `memoryContext: { project?, agent?, writer?, scope?, includeAllProjects? }`，
其中的記憶候選採同一召回條件；檔案篩選仍依 roots。MCP 呼叫會明確帶入記憶情境。
原文召回續讀仍走 `/memory-sources/:id` 並重驗用途；管理頁讀全文走
`GET /memory-library/source/:id`，讓停用資料仍可查看。
接入端以回應的 `recallVersion` 與目前 `dataRevision` 核對快取，遮罩修訂另行核對。
這些檢查不能追回已交給模型的文字，也不構成同 token 之間的身分隔離。

## 備份與相容

預設 NDJSON 備份使用 schemaVersion 3，保存短記憶、原文來源、組織快照與召回規則。
v3 的短記憶行另必帶 `dedupe: { scope, project }`，保存原寫入請求的去重維度，不含內容 hash。
這讓更改用途後的備份匯回同庫仍能去重，也避免原請求不同但目前用途相同的兩筆記憶誤合併。
此資料只用於備份與受信還原，一般清單與單筆讀取不回傳內部去重欄位。
仍可匯入 v1／v2；舊格式缺少來源資訊時不猜填。匯入組織快照不會被目前的新寫入規則覆蓋。
舊格式匯出不能靜默省略新 metadata 或規則；無法表示時須拒絕降版。

匯入 `rulesMode` 預設為 `preserve`，保留目的庫目前規則；介面提供明示選項還原備份規則。
`replace` 要帶 `expectedRevision`，先驗證整份備份並完成規則 CAS，失敗時不匯入記憶。
規則替換成功後，記憶沿既有逐筆匯入與衝突回報流程；若部分失敗，回應須如實列出規則已還原
與實際成功、重複及衝突數，不能聲稱整批未變。還原規則不重新改寫庫內原有記憶的用途。

備份仍依當下遮罩設定產生，不含向量、內部 requestHash、刪除事件 tombstone 或已刪歷史。
還原會重新配置數字 ID、切塊及嵌入；這是內容備份，不是原資料庫的無損複製，
不能保證還原後的舊 spool 與原庫具有相同的事件查重結果。單次匯入仍限 32 MiB。
