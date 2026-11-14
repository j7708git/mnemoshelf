# 儲存介面（Ports）

儲存分成兩個窄介面，各自可替換。**不要**做成單一的「通用資料庫介面」。

## 原文來源與政策擴充

原文回合以 `memory_sources` 保存，既有 `memories` 保存帶來源位置的檢索片段，沿用全文與向量索引。
來源、片段與全文索引同交易保存；不新增另一套檔案 VectorIndex。記憶遮罩由持久 `MemoryPolicy`
控制，預設開啟。來源讀取、整回合生命週期、備份與錯誤語意的現行契約見
[原文記憶](raw-memory.md)；下方帶日期的舊記憶段落說明相容基礎，不覆蓋新來源行為。

記憶組織欄位、完整管理分頁、物化召回規則、修訂競態與 schemaVersion 3 備份見
[記憶整理與召回規則](memory-organization.md)。此契約優先於下方舊 scope／project／去重與 v1/v2 段落；
`SearchFilter.memoryFilter` 使通用搜尋的記憶候選與專用召回採相同過濾，`listMemoriesForRecall`
供最近回合召回。停用資料在排名前排除，管理查詢仍可讀。
短記憶去重另保存原請求的內部 `dedupe_scope`／`dedupe_project`，並把 `assignedProject` 加入 key，
防止用途規則改變造成重複寫入，或不同歸屬的共用記憶誤合併。

MetadataStore 新增政策讀寫、來源新增／查重／讀取／列舉／範圍更新／刪除、來源片段列舉／重建與索引狀態統計。
`Memory` 的 sourceId、messageIndex、chunkIndex、sourceStart、sourceEnd、chunkVersion 均為 additive nullable 欄位。
短記憶仍走原去重；來源依事件識別去重，相同文字不同事件不得合併。任一來源片段的刪除、共享及釘選同步整回合。

> **修訂紀錄**：2026-10-14（M2）修訂「搜尋排序」——`/search` 預設由 `hybrid`（RRF 合併）改為
> `vector`（向量優先），`hybrid` 與 `keyword` 保留為選用；並新增 §搜尋模式與預設、§PostgreSQL 後端。
> 舊語意以註記保留在 §設計規則 1，方便讀舊文件的人。
>
> 2026-10-14（M3）新增 §記憶的釘選：`Memory.pinned` 欄位與 `MetadataStore.setMemoryPinned`
> 方法（兩後端皆實作、通過同一組契約測試）；`listMemories` 的排序語意不變。
>
> 2026-10-16 新增 §root 設定的更新：`MetadataStore.updateRoot(id, patch)` 與 `RootPatch`
> 型別（目前僅 `modalities`）——兩後端皆實作、通過同一組契約測試。
>
> 2026-11-12 擴充 §root 設定的更新：`RootPatch` 新增 `allowAgentSearch`（分享意圖；預設
> `false`）與 `maxFileBytes`（通用單檔上限；nullable，未設定沿用服務層 10 MiB）；
> `Root.allowAgentSearch` 為 required boolean，`Root.maxFileBytes` 選填。SQLite migration
> `0009_root_agent_search_and_max_file_bytes` 與 PostgreSQL schema 同步；另新增
> `SearchFilter.includeMemories`（讓呼叫端只縮小檔案範圍、仍保留記憶）。
>
> 2026-10-18 新增 §記憶的範圍更新：`MetadataStore.updateMemory(id, patch)` 與
> `MemoryPatch` 型別（僅 `scope`／`project`）——兩後端皆實作、通過同一組契約測試；
> 既有的記憶方法（新增、釘選、軟刪除、列舉、關鍵字搜尋）與排序語意不變。
>
> 2026-10-18 新增 §記憶的語意化：`memories` 的向量欄位、`MemoryEmbeddingState`
> 與 `MetadataStore` 的四個記憶向量方法（`markMemoryEmbedded`、`markMemoryEmbeddingFailed`、
> `listMemoriesNeedingEmbedding`、`memoryEmbeddingStats`）——兩後端皆實作、通過同一組契約測試；
> `Memory` 公開型別、`VectorIndex`、`/search` 與召回 API 都不變。
>
> 2026-10-18 新增 §記憶檢索：`MemorySearchBucket`／`MemorySearchFilter` 與
> `MetadataStore.searchMemoriesByVector`／`searchMemoriesKeyword`（**先過濾再排名**）——兩後端皆實作、
> 通過同一組契約測試；`/search`、`VectorIndex` 與檔案索引管線不變。
>
> 2026-10-19 新增 §記憶的寫入去重與硬刪除：`memories.content_hash`、`MetadataStore` 的三個新方法
> （`addMemoryUnlessDuplicate`、`normalizeLegacyMemoryScopes`、`hardDeleteMemory`）與
> `DELETE /memories/:id?hard=true`——兩後端皆實作、通過同一組契約測試；`Memory` 公開型別、
> 召回與 `/search` 的既有語意不變。
>
> 2026-10-19 新增 §記憶的匯出／匯入：`MetadataStore.listMemoriesForExport()` 與 REST
> `GET /memories/export`／`POST /memories/import`（NDJSON、`dryRun`、32 MiB 上限）——兩後端皆實作、
> 通過同一組契約測試；本版**只做記憶**（不含 chunk／向量）。設計規則 6 同步改為誠實版本。
>
> 2026-10-21 新增 §記憶的來源欄位：`Memory.sourceSession`／`sourceMessage`（additive、可空）與
> SQLite 遷移 `0005_memory_provenance`；匯出 `schemaVersion` **維持 1**（舊備份缺欄位可匯入，
> 補 `null`）。既有欄位語意、去重 key、排序與搜尋都不變。
>
> 2026-11-08（影片里程碑三 B3a）新增 §影片片段的媒體定位與 seq 規則：`ChunkMedia` 擴充
> `track`（`audio`／`video`／`video-audio`）、`container`、`streamIndex`、`frameTimesSeconds`
> （additive；舊音訊列照舊可讀）。**storage 不改 schema**——新欄位全部在既有的
> `chunks.media_json` 內（SQLite／PostgreSQL 相同），不需要新 migration。同節記錄跨軌 `seq`
> 排序規則與共用 helper，以及掃描／預覽的影片語意（`.mp4` 白名單、`videoMaxFileBytes`、
> 跳過原因分組）。兩個後端跑同一組契約測試；PostgreSQL 仍需 `MNEMOSHELF_PG=1` 才是實跑。

| 介面 | 職責 | 預設實作 | 預計的替代實作 |
|---|---|---|---|
| `MetadataStore` | roots、檔案、chunk 文字、記憶、設定、遷移 | SQLite | PostgreSQL |
| `VectorIndex` | 寫入向量、帶過濾條件的 top-k 近鄰查詢 | sqlite-vec | LanceDB、pgvector |

## 設計規則

1. **排序在應用層；預設只跑向量那一路，混合為選用。** 每個後端只負責各自擅長的排名：
   - `MetadataStore.searchKeyword(query, filter, k)` 回傳關鍵字排名清單；
   - `VectorIndex.searchVector(vec, filter, k)` 回傳向量排名清單；
   - 由應用層的 `mode` 決定跑哪幾路：預設 `vector`（只跑向量）、`keyword`（只跑關鍵字）、
     `hybrid`（兩路都用 Reciprocal Rank Fusion（RRF，`score = Σ 1 / (60 + rank)`）合併）。
   如此換後端時，排序行為保持一致。

   > **2026-10-14（M2）修訂：搜尋預設由 `hybrid`（RRF）改為 `vector`。**
   > 原文為「**混合排序在應用層**……由應用層用 RRF 合併」，並以 `hybrid` 為 `/search` 預設。
   > 依 M1 整體驗收的三模式複測（見 §搜尋模式與預設），向量單獨優於混合與關鍵字；
   > RRF 實作與 `hybrid`／`keyword` 模式**保留不刪**，只是降為選用（明確帶 `mode` 仍可用）。
2. **每筆向量帶 `embedder_id` 與 `dim`。** 換 embedder 時能判斷哪些要重建。
3. **過濾條件至少支援 `root_id`**（權限與刪除都以 root 為單位），
   之後可擴充 `kind`、`path` 前綴。
4. **單一寫入者。** 只有核心服務行程寫入資料庫；MCP、CLI、UI 都經由本機 HTTP。
5. **契約測試。** 同一組測試套件對每個實作都要通過；新增後端就是讓它通過同一組測試。
6. **中立的匯出格式。** 提供匯出與匯入，用於備份與跨後端搬遷。**本版範圍：記憶的 JSON Lines
   （NDJSON）備份——不含 chunk／向量與已刪除的歷史版本；匯入後由背景 worker 重建向量。**
   chunk／向量與整庫搬遷（含向量檔）仍列後續；見 §記憶的匯出／匯入。

## 搜尋模式與預設（M2 修訂）

`/search`（REST）與 MCP 的 `search` 工具支援三種 `mode`：

| `mode` | 跑哪幾路 | 排序 | 記憶是否納入 |
|---|---|---|---|
| `vector`（**預設**） | `VectorIndex.searchVector` | 後端回傳的向量名次 | 否（檔案 VectorIndex 不含記憶；記憶向量走獨立召回入口） |
| `keyword` | `MetadataStore.searchKeyword` | 後端回傳的關鍵字名次 | 是 |
| `hybrid` | 兩路 | 應用層 RRF（`score = Σ 1 / (60 + rank)`）合併 | 是 |

**為什麼預設改為 `vector`（M1 實測）**：M1 整體驗收以 8 個自然語句查詢對三模式複測，Top-1 為相關結果的
次數為 **`vector` 8/8 ＞ `hybrid` 7/8 ＞ `keyword` 5/8**。關鍵反例：以中文查詢找圖時，`hybrid` 的
keyword 路把 vector 路原本正確的命中壓了下去（RRF 讓兩路等權，關鍵字路的雜訊拉低正確結果的名次）。

**樣本限制（重要）**：只有 8 個查詢、且「相關」是 tester 自評，**不是嚴謹的檢索評測**；查詢集與語料都小。
此修訂是依現有最佳證據做的方向性決定，未來有更大的查詢集時應複測。

**`hybrid` 與 `keyword` 保留不刪**：兩者仍是正式模式，明確帶 `mode` 即照舊可用；RRF 實作保留在應用層
（見 §設計規則 1）。需要固定行為的呼叫端請一律明確帶 `mode`。**記憶只進 keyword 那一路**，因此預設
`vector` 不含記憶命中；要搜尋記憶請帶 `mode: "keyword"` 或 `"hybrid"`。

### `SearchFilter.includeMemories`（2026-11-12）

`SearchFilter` 除 `rootIds` 外另有一個選填的 `includeMemories`，只影響
`MetadataStore.searchKeyword` 的記憶名次（向量索引本身不含記憶）：

| 值 | 語意 |
|---|---|
| `undefined`（預設） | 既有規則：未指定 `rootIds` 時納入記憶；指定了 `rootIds`（含空陣列）時不納入 |
| `true` | 即使指定了 `rootIds`（含空陣列）也納入記憶；chunk 仍只搜指定（或空）roots |
| `false` | 一律不納入記憶 |

用途：`POST /search` 的 `agentOnly` 只縮小檔案搜尋範圍、不影響記憶召回，因此伺服器在
`agentOnly: true` 且使用者未指定 `rootIds` 時會帶 `includeMemories: true`；使用者有指定
`rootIds` 時維持「記憶不納入」的既有語意。兩個後端以同一組契約測試驗證此欄位。

## 音訊片段與增量索引

`Chunk.media` 是選填的時間片段資料；既有文字、程式碼、圖片與舊版資料**省略**此欄，不補 `null`。
音訊里程碑時時間片段限音訊，`Chunk.text` 為 `null`，不產生或冒充語音轉錄；2026-11-08 起新增影片片段，沿用同一形狀擴充（見 §影片片段的媒體定位與 seq 規則），下列是當時的音訊形狀：

```ts
interface ChunkMedia {
  startSeconds: number;
  endSeconds: number;
  track: "audio";
  preprocessVersion: string;
  embedderId: string;
  embeddingDim: number;
}
```

- 時間使用原始來源的秒數，區間為 `[startSeconds, endSeconds)`；起點必須有限且非負，終點必須有限且大於起點。
- `preprocessVersion` 包含解碼／混音／重採樣、分段與極短輸入補零政策；音訊目前為
  `wav-pcm-mono16k-sinc-v1:10s:audio-pad160-v1`。影片畫面為
  `mp4-h264-rgb24-v4:4s:1f:384:srcpts-v3`、影片所選音軌為
  `mp4-aac-mono16k-v2:10s:clamp-v1:stream-align-v1`（再加 `audio-pad160-v1` 與 decoder 版本）；
  視覺 v4 由 decoder 提供來源 PTS 佈局，視覺與音軌都以容器 sourceStartSeconds 為播放原點；v2／v3 舊索引重跑時必須重建；音軌仍維持 v2 的 per-stream 時長對齊。模型前處理不足 160 樣本時補零到 160 樣本，
  來源起訖時間不因補零延長，避免極短尾段被模型前處理丟失。
  `embedderId`／`embeddingDim` 記錄向量身分。欄位在寫入前共用驗證，非法資料拒絕且不刪除既有片段。
- SQLite 遷移 `0007_chunk_media` 新增 nullable `chunks.media_json text`；PostgreSQL 以
  `add column if not exists` 補同欄。遷移不重建原表、不刪除舊 chunk 或向量，並可重複執行。
- `replaceChunks`、`getChunks`、`listChunksByPath` 完整保存並回傳定位資料；向量搜尋命中的 chunk id
  可藉此定位回來源音訊。沒有將檔名或定位資訊混入音訊內容向量。
- 音訊的 `contentHash` 仍是原始檔案位元組 SHA-256。只有 hash、片段數／順序／完整時間覆蓋、
  前處理版本、模型身分與維度全相同，且每個向量 key 都存在時才跳過重算。少尾段或缺向量時整檔重建。
- 每檔所有片段嵌入成功才替換其 chunk 與向量；取消或推論失敗不發布半份索引。
  替換仍沿用先刪舊向量、再替換 chunk、再寫新向量的自癒順序。壞格式／無效音訊／超限檔
  則列為具名跳過並回收其舊索引；未支援的副檔名在掃描時記 `unsupported-audio-format`。
- WAV 預設每段 10 秒；每次只準備一段 PCM，最後不足 10 秒仍保存。共用 embedder 的多個 root
  合計最多持有 2 個音訊檔的讀取／處理名額（在讀 WAV 前取得，完整處理後釋放，等待可取消）；
  含音訊 root 的檔案併發也最多 2；
  序列推論裝置仍為 1。既有 10 MiB 單檔預設上限保留，解碼另限制 64 MiB 原始輸入、600 秒時長，
  不會因調大通用檔案大小選項就移除音訊護欄。
- 預覽只列舉而不讀內容，因此 WAV 是候選格式，實際 codec 與時長在確認索引後驗證。
  音訊片段估值以最低支援位元率（8 kHz、PCM16、mono）推估上界、最多 60 段；
  每段 5 秒的成本是保守規模提示，不是裝置效能保證。服務端依實際嵌入能力限制預覽模態。

SQLite 與 PostgreSQL 共用兩項新增契約測試（往返與非法輸入不損資料）。SQLite 遷移已另有
舊資料庫升級測試；PostgreSQL 必須在啟用 `MNEMOSHELF_PG=1` 的環境實跑，未啟用時不能宣稱驗收通過。

## 影片片段的媒體定位與 seq 規則（2026-11-08，影片里程碑三 B3a）

影片索引沿用 `Chunk.media`，因此**不需要新的表或 migration**：新欄位全部寫在既有的
`chunks.media_json`（SQLite／PostgreSQL 都是 `text`）內，兩後端走同一個 JSON 欄位。
舊音訊列只有 `track:"audio"` 與三個嵌入身分欄位；讀回時**不得**補 `container`／
`streamIndex`／`frameTimesSeconds`（不得變成 `container: undefined` 這類多出來的鍵）。

```ts
interface ChunkMedia {
  startSeconds: number;
  endSeconds: number;
  track: "audio" | "video" | "video-audio";
  /** 來源容器；舊資料省略。 */
  container?: "wav" | "mp4";
  /** 影片所選音軌的 stream index（`track:"video-audio"` 必填）；畫面片段可省略。 */
  streamIndex?: number;
  /** 畫面片段實際採用的幀時間（秒；`track:"video"` 必填）。 */
  frameTimesSeconds?: number[];
  preprocessVersion: string;
  embedderId: string;
  embeddingDim: number;
}
```

| `track` | `kind` | 意思 | 必填欄位 |
|---|---|---|---|
| `video` | `video` | 影片**畫面**片段（每 4 秒一段、每段 1 幀） | `frameTimesSeconds` |
| `video-audio` | `audio` | 影片**所選音軌**片段（沿用 10 秒音訊片段） | `streamIndex` |
| `audio` | `audio` | 舊資料與獨立 WAV 音訊片段 | 無（僅舊欄位） |

- 影片音軌片段的 `kind` 仍是 `"audio"`（沿用既有音訊嵌入與搜尋語意），以 `media.track`
  區分來源；「畫面」與「音軌」的差別看 `media.track`，不是看 `kind`。
- `container` 選填（舊資料沒有）；有值必須是 `wav`／`mp4`。影片 v1 只支援 `.mp4`。
- `streamIndex` 是影片所選音軌的 stream index（多音軌政策：第一個 default AAC，否則第一個
  AAC）；`track:"video-audio"` 必填、整數 ≥ 0。畫面片段可省略（可帶視覺 stream index）。
- `frameTimesSeconds` 是該片段**實際解碼來源幀的 PTS**（秒，播放時間軸 0-based；不是 fps 抽樣格線、
  也不是平均 FPS 推估值）：`track:"video"` **必填**、長度 1–32、非遞減、每個值落在
  `[startSeconds, endSeconds]`；音軌片段**不得**帶此欄。抽樣政策已凍結為每段 1 幀
  （0.25 fps、每段 4 秒）：完整段取段中點之後第一幀、尾段取段內最後一幀，因此目前長度固定 1。
  時間線無法可靠定義時整檔具名跳過 `unsupported-video-timeline`，不寫入推測值。
  decoder 的 `probe.visualTimeline` 提供段界與來源 PTS；indexer 的預期片段、實際輸出驗證及增量比對
  共用這份佈局，不能只從容器時長推算段數。增量比對也核對實際幀時間，不只核對段數。
  容器結尾略跨段界而最後不足 4 秒的格子沒有 PTS 時，只有末幀的實際 `duration_time` 證明覆蓋結尾
  才省略該空格；前段仍結束於原本 4 秒邊界。容器只允許向上毫秒量化差、六位小數相加的一微秒差；
  不推估 FPS、不省略完整空段或中間空段，尾格有 PTS 時仍保留。
  長片非格線 pick 使用平衡加法樹的 `between` select（最多 600 項／28,000 字元）；
  等距格線仍可壓縮。正常無競爭時同一程序解完整片；跨 root 讓出程序才在段界以 `-ss` 恢復。
  佈局或解碼覆蓋不一致一律 `unsupported-video-timeline`，不發布部分索引。
- 驗證由 `normalizeChunkMedia`（`ports/metadata-store.ts`；兩後端與呼叫端共用同一個入口）
  負責；非法資料拋 `TypeError`，`replaceChunks` 拒絕寫入且**不刪除**既有片段（與音訊
  里程碑相同）。runtime 白名單另匯出 `CHUNK_MEDIA_TRACKS`／`CHUNK_MEDIA_CONTAINERS`／
  `CHUNK_MEDIA_MAX_FRAME_TIMES`。

### seq 規則（同檔跨軌唯一且穩定）

`Chunk.seq` 在同一檔案（`rootId`＋`relPath`）內**唯一**、0 起算、連續。排序鍵依序：

1. `startSeconds` 升冪；
2. 同時刻依軌道：`video` → `video-audio` → `audio`（畫面先於音軌）；
3. `endSeconds` 升冪；
4. 都有 `frameTimesSeconds` 時比較第一個幀時間；
5. 仍相同＝等價，維持傳入順序（ES2019 起 `sort` 保證穩定）。

純音訊檔（既有 WAV）排序結果與現行的「`seq` = 片段索引」完全相同，因此舊資料不必重編號。
索引端不得自行排序：`compareChunkMediaOrder(a, b)` 是比較器，`assignChunkMediaSeq(chunks)`
回傳重新編號後的新陣列（不改傳入物件）；兩者都在 `ports/metadata-store.ts`，
**尚未**從 `@mnemoshelf/core` 公開入口 export（本輪未改 `src/index.ts`，由 PM 統一補）。

> 例：12 秒畫面＋11.8 秒 AAC、`video` 與 `audio` 都開啟 ⇒ 畫面 0–4／4–8／8–12（`video`）、
> 音軌 0–10／10–11.8（`video-audio`；段界用音軌自身時長，不是容器 12 秒）；`seq` 依序是
> 0＝畫面 0–4、1＝音軌 0–10、2＝畫面 4–8、3＝畫面 8–12、4＝音軌 10–11.8。
> 音軌起點晚於 0 時，decoder 在 leading offset 補靜音並回傳已對齊播放時間軸的片段；
> 樣本數只允許 AAC priming 級容差（約 `max(2048, 0.1%)`），不沿用半秒級寬容。

### 讀寫、遷移與舊資料

- `replaceChunks`／`getChunks`／`listChunksByPath` 完整保存並回傳新欄位（`media_json` 往返）；
  沒有把檔名、時長或容器混入向量內容。
- **沒有新 migration**：SQLite 的 `0007_chunk_media` 已提供 nullable `media_json text`，
  PostgreSQL 的 `migrate()` 以 `add column if not exists media_json text` 對齊——新欄位是
  JSON 內容的 additive 擴充，兩者都不重建表、不刪除舊 chunk 或向量，且可重複執行。
- 舊音訊列（沒有新欄位）照舊可讀：JSON 驗證接受只有 `track:"audio"` 的舊形狀；
  `sqlite.chunk-media.test.ts` 另有「先建到 0006、插舊列、再升級」的舊資料庫升級測試。
- 增量身分（原始 hash、模型／維度、decoder 與前處理版本、片長／抽樣／縮放、音軌選擇、
  所要求的 tracks）與「每檔所有軌都成功才替換、失敗不發布部分索引」由索引端（B3b）負責；
  本輪只保證儲存層能完整保存與回傳，供增量比對使用。

### 契約測試

`@mnemoshelf/core/testing` 的 `runMetadataStoreContract` 擴充下列案例（SQLite 與 PostgreSQL
跑同一組；PostgreSQL 需 `MNEMOSHELF_PG=1` 才是實跑）：

- 舊音訊定位往返：`getChunks`／`listChunksByPath` 讀回與寫入完全相同，且不多出
  `container`／`streamIndex`／`frameTimesSeconds` 鍵；文字 chunk 仍省略 `media`。
- 影片畫面＋影片音軌（`.mp4`、`frameTimesSeconds`、`streamIndex`）往返；`seq` 由
  `assignChunkMediaSeq` 排序成同檔唯一編號（畫面先於音軌、再依時間）。
- 非法資料拒絕且不刪除既有片段：一般欄位（時間、版本、embedder、維度）＋影片專屬欄位
  （`track` 非白名單、`container` 非白名單、畫面缺／多幀時間、幀時間越界或遞減、`streamIndex`
  缺漏或非整數、音軌片段帶幀時間）。

另有 `packages/core/test/chunk-media.test.ts`（驗證器與 `seq` 規則的單元測試）、
`sqlite.chunk-media.test.ts`（遷移冪等與舊列相容）。

### 掃描與預覽的影片語意（摘要）

> 這一小節是 B3a 的實作摘要；產品層的模態語意、per-root 上限與 UI 文案見
> `docs/roots-and-privacy.md`／`docs/operations.md`。per-root `videoMaxFileBytes` 由 C4
> 以 SQLite migration `0008_root_video_max_file_bytes`（nullable）與 PostgreSQL
> `add column if not exists` 持久化，詳見本文件 §root 設定的更新。

- **只在呼叫端宣告支援時納入**：`walkRoot`／`previewRoot` 的 `supportedModalities` 含 `video`
  才把影片列入候選；未宣告時沿用既有 `unsupported-modality`（服務端在 B3b／C 接線前行為不變）。
- **v1 容器白名單 `.mp4`**：副檔名不是 `.mp4` 的影片在掃描階段記 `unsupported-video-format`；
  `.mp4` 只是第一道篩選，實際 codec 由確認索引後的受控探測判斷。`isSupportedVideoFileName()`
  是白名單的單一實作。
- **明確的影片大小上限**：`ScanOptions.videoMaxFileBytes`，預設
  `DEFAULT_VIDEO_MAX_FILE_BYTES`＝512 MiB；超過記 `video-too-large`。通用 `maxFileBytes`
  （預設 10 MiB）**不套用影片**。per-root 值存於 `Root.videoMaxFileBytes`（C4 落地），
  未設定時服務端以 `MNEMOSHELF_VIDEO_MAX_FILE_BYTES` 或 512 MiB 作預設。
- **跳過原因分兩組**（不得混用）：掃描可判定＝`unsupported-video-format`、`video-too-large`；
  需 probe／decode 才知＝`video-duration-exceeded`、`invalid-video`、`unsupported-video-codec`、
  `unsupported-video-audio-track`、`unsupported-video-timeline`（時間線無法可靠定義；由索引／解碼
  階段產生，映射為 skipped，不讓整輪 failed）。
- **時長上限不猜**：`VIDEO_MAX_DURATION_SECONDS`＝600 秒；掃描與預覽不讀媒體，無法判定。
- **預覽不讀媒體、不啟動 probe、不由壓縮大小換算時長**：`RootPreview.video` 提供
  `files`／`durationKnown:false`／`includesAudioTrack`／`visualSegmentsPerFileMax`＝150（600 秒
  ÷ 4 秒）／`audioSegmentsPerFileMax`＝60（600 秒 ÷ 10 秒）／`estimatedSegmentCountMax`／
  `estimatedSecondsMax`，全部標明是**上界**。
- `estimatedChunks`／`estimatedSeconds` **不含**影片未知成本（影片每檔只計 1 段的可解釋最小量），
  避免把 5 秒短片估成數百秒；影片上界只在 `video` 物件內，UI 顯示「影片時長待確認」。

## 記憶的釘選（M3 擴充）

管理面的標記：`Memory.pinned: boolean`（型別見 `ports/types.ts`）。既有資料與新增的記憶一律
預設 `false`；`NewMemory` 刻意**不含** `pinned`，要釘選請用下列方法。

| 方法 | 語意 |
|---|---|
| `MetadataStore.setMemoryPinned(id, pinned)` | 設定／取消釘選，**冪等** |

- **不存在的 id 是無操作**（不拋錯），與 `forgetMemory` 的既有風格一致；需要回 404 的
  呼叫端（REST）請先 `getMemory` 判斷存在與否。
- `pinned` **不影響** `listMemories` 的排序（仍是 `createdAt` 由新到舊、同毫秒以 `id` 決勝）；
  「釘選優先」的排序由呼叫端（UI）自行處理，後端契約因此不必變動既有排序語意。
- `getMemory` 與 `listMemories` 回傳的 `Memory` 都帶正確的 `pinned`。

**兩個後端的實作**：

- **SQLite（預設）**：欄位 `memories.pinned integer not null default 0`；以版本化遷移
  `0002_memory_pinned` 補欄位（先查 `pragma table_info` 再 `alter table add column`，維持冪等），
  既有資料庫的既有資料自動為 `0`。
- **PostgreSQL**：欄位 `pinned boolean not null default false`；`migrate()` 除了 `create table`，
  另以 `alter table … add column if not exists pinned …` 補既有資料庫的欄位（冪等）。

契約測試（`@mnemoshelf/core/testing` 的 `runMetadataStoreContract`）新增兩例：釘選／取消
（含冪等，且 `getMemory` 與 `listMemories` 都反映），以及不存在 id 的無操作。SQLite 與
PostgreSQL 兩個後端都必須通過同一組測試。

## root 設定的更新（2026-10-16）

root 建立之後只有一部分設定可變更；`MetadataStore.updateRoot(id, patch)` 是唯一入口，
可變欄位由 `RootPatch`（`ports/types.ts`）界定。

| 方法 | 語意 |
|---|---|
| `MetadataStore.updateRoot(id, patch)` | 更新 `RootPatch`（`modalities`、`allowAgentSearch`、`maxFileBytes` 與 `videoMaxFileBytes`）；回傳**更新後**的 `Root` |

- **目前可改 `modalities`、`allowAgentSearch`、`maxFileBytes` 與 `videoMaxFileBytes`。**
  - `allowAgentSearch`：boolean，預設 `false`；只影響之後 agent 的搜尋範圍，不動既有索引。
  - `maxFileBytes`：bytes、整數 1 B–16 GiB；`null` 表示清除設定（回到服務層預設 10 MiB），
    `undefined` 表示不變。驗證走 `normalizeRootMaxFileBytes`（與 `Root.maxFileBytes` 相同，
    未設定時讀回**不出現**該鍵）。
  - `videoMaxFileBytes`：bytes、整數 1–16 GiB；`null` 表示清除設定（回到服務層預設），
    `undefined` 表示不變。
  - `path`／`mode` 變更等同換一個 root（索引內容與清理語意都會變），應以「移除再加入」處理；
    `include`／`exclude`／`respectGitignore` 尚無變更語意，故不在 `RootPatch`。
- **冪等**：同樣的 patch 重複套用結果相同；`patch` 未提供的欄位＝該欄位不變。空陣列 `[]` 是合法值
  （＝全部模態關閉，與 `addRoot` 接受空陣列一致），與「未提供該欄位」不同。
- **回傳更新後的 `Root`**，呼叫端不必再讀一次；`getRoot` 與 `listRoots` 也都反映新值。
- **不存在的 id 回 `null`**（不拋錯，與 `setMemoryPinned` 對不存在 id 的「無操作」風格一致，
  也不會建立新列）；REST 層據此回 `404`。既有資料與 `createdAt` 等不可變欄位原樣保留。
- **只改設定，不動既有資料。** 新模態在下一次 `indexRoot` 才生效：關掉模態**不會立刻**釋放既有的
  chunk／向量（重新索引時才由清理迴圈清掉），開新模態也不會自動補索引。
- **與 `removeRoot` ＋重新 `addRoot` 的差異**：`updateRoot` 保留同一個 `id`、`createdAt` 與既有
  chunks／向量，適合「只是想多索引一種模態」；`removeRoot` ＋ `addRoot` 會得到新 `id`，
  既有索引與衍生資料需重建（`removeRoot(id, true)` 會連 chunks 一起刪掉）。
- 契約測試（`@mnemoshelf/core/testing` 的 `runMetadataStoreContract`）涵蓋：更新並回傳
  （不可變欄位原樣保留）、冪等與關閉模態、`patch` 未提供欄位、不存在的 id，以及
  `allowAgentSearch` 的預設／更新、`maxFileBytes` 與 `videoMaxFileBytes` 的
  設定／讀回／清除／1 B–16 GiB 邊界與非法值不改資料。SQLite 與 PostgreSQL
  兩個後端都必須通過同一組測試；SQLite migration `0008_root_video_max_file_bytes` 與
  `0009_root_agent_search_and_max_file_bytes` 為 nullable／default false、冪等，
  舊 row 讀回時不補鍵、既有 root 的 `allowAgentSearch` 一律 `false`。

## 記憶的範圍更新（2026-10-18）

共享開關（切換單筆記憶的 `scope`／`project`；`scope` 可為 `global`／`project`／`agent`）的唯一
寫入入口是 `MetadataStore.updateMemory(id, patch)`；可變欄位由 `MemoryPatch`（`ports/types.ts`）
界定。UI 只提供「專案 ↔ 全域」切換；`agent` 範圍可由 REST `PATCH /memories/:id` 設定，
切換時沿用原本的寫入者（`agent` 不在 `MemoryPatch` 內）。

| 方法 | 語意 |
|---|---|
| `MetadataStore.updateMemory(id, patch)` | 更新 `MemoryPatch`（`scope?`／`project?`）；回傳**更新後**的完整 `Memory` |

```ts
/** 只允許改這兩個欄位；未提供的欄位維持原值。 */
export interface MemoryPatch {
  scope?: MemoryScope;
  project?: string | null;
}
updateMemory(id: number, patch: MemoryPatch): Promise<Memory | null>;
```

- **不存在或已軟刪除**（`deletedAt != null`）→ 回 `null`（不拋錯、也不改資料）；REST 層據此回 `404`。
- **有效結果的正規化**（`normalizeMemoryPatch`；兩後端與 REST／MCP 共用同一套語意）：
  - `scope === "project"` → `project` 必須是非空字串（trim 後儲存）；否則拋錯。
  - `scope !== "project"` → `project` 一律為 `null`（即使 patch 沒帶 `project`，也會把現值清掉）；
    呼叫端明確給非 null 的 `project` 是矛盾請求 → 拋錯，不靜默忽略。
  - 兩個欄位都沒提供 → 非法 patch，拋錯。
- **合併方式**：以現值為基底套用 patch；`scope` 未提供時維持原範圍（例如只帶 `project` 就是改專案名稱）。
- **不可變欄位**：`content`、`kind`、`agent`、`supersedes`、`pinned`、`createdAt`、`deletedAt`
  原樣保留。內容的變更一律走 supersede（建立新版本、舊版軟刪除），不經此方法。
- **冪等**：同一個 patch 重複套用結果相同。
- **兩個後端的實作**：SQLite 先讀回現值，再以 `update … where deleted_at is null` 寫入（之後重讀）；
  PostgreSQL 以 `update … returning` 在同一次查詢取回更新後的列。本專案是**單一寫入者**，
  「讀到之後才被軟刪除」的競態不會發生，因此兩者在實際使用下語意一致；若未來放寬單一寫入者，
  需重新定義這個回傳語意。
- 契約測試（`@mnemoshelf/core/testing` 的 `runMetadataStoreContract`）新增六例：更新並回傳
  （不可變欄位原樣保留）、`scope` 正規化、冪等、不存在的 id、已軟刪除的 id、非法 patch。
  SQLite 與 PostgreSQL 兩個後端都必須通過同一組測試。
- REST 對應：`PATCH /memories/:id`（語意見 `docs/roots-and-privacy.md` §記憶的範圍與共享）。

## 記憶的寫入去重與硬刪除（2026-10-19）

### 精確去重（寫入時）

- **正規化**：`normalizeMemoryContentForHash`（core 共用；呼叫端不得各自實作）＝Unicode NFC →
  去除前後空白 → 連續空白（含換行）收斂為單一空格；**不轉大小寫、不動標點**。
  `memoryContentHash` 為正規化後 UTF-8 的 sha256 hex。
- **去重 key**＝（`content_hash`, `scope`, `project`, `agent`）；`project` 以 null-safe 比較；
  **已軟刪除者不計入**。內容是呼叫端依當下遮罩政策處理後的內容（REST／MCP 先遮罩再寫入）。
- `memories.content_hash` 由遷移 `0004_memory_content_hash` 補上並回填既有列；兩後端共用同一個
  hash 函式，不得各自解讀正規化規則。
- `MetadataStore.addMemoryUnlessDuplicate(m)`：**原子** insert-or-return-existing；回
  `{ memory, duplicate }`。同 key 已有未刪除記憶時回既有列（`duplicate: true`）、不新增、不 enqueue；
  否則與 `addMemory` 相同地新增（含 FTS 維護、`content_hash`、`supersedes` 軟刪除、`pinned=false`）。
  `supersedes` 有值時仍先標記被取代者；REST 的編輯流程另行跳過去重。
- REST：`POST /memories` 支援 additive `force: true`（強制新增、回 `201`）；重複回 `200`＋既有記憶
  ＋`duplicate: true`。`Memory` 公開型別不變。

### legacy scope 正規化

`MetadataStore.normalizeLegacyMemoryScopes()`：啟動時呼叫一次、**冪等**；把舊版矛盾資料收斂為
合法組合——`scope in ('global','agent')` 但 `project` 非 null → `project = null`；
`scope = 'project'` 但 `project` 為 null／空字串 → `scope = 'global'`（無法猜專案）。
回傳實際更新列數；不清除、不合併任何記憶內容。

### 硬刪除

`MetadataStore.hardDeleteMemory(id): Promise<boolean>`：刪除資料列（含 FTS 列；向量是同列欄位）、
可刪已軟刪除者、未知 id 回 `false`。REST：`DELETE /memories/:id?hard=true`（只接受 `true`／`1`，
其他值 `400`；未帶參數維持軟刪除）。**不做取證級抹除**（SQLite WAL／檔案系統頁面可能殘留、
at-rest 仍明文、無加密），見 `docs/roots-and-privacy.md` §資料存放與刪除。

### UI（面板）行為

記憶管理面板的卡片提供「永久刪除」（走 `DELETE /memories/:id?hard=true`）：**二次確認**，
確認文案明示無法復原，且 WAL／檔案系統頁面可能有殘留——與同節 §硬刪除 的「不做取證級抹除」一致。

`POST /memories` 的重複提示（`duplicate: true`）在面板端是**防禦性處理**：目前 UI **沒有**
新增記憶表單，記憶主要由 agent 經 REST／MCP 寫入，所以這個回應不是面板的主要互動路徑；
面板的編輯流程一律帶 `supersedes`（走編輯路徑、不套用去重）。面板端對 `duplicate: true` 也有
一段防禦性分支（只提示「已有完全相同內容」、不新增卡片），但正常走不到；對直接呼叫 REST
的呼叫端（含 agent）才是主要情境。

## 記憶的匯出／匯入（2026-10-19）

以下 v1 為短記憶相容格式；預設匯出為 v3，含原文來源、組織快照與召回規則，詳見 [原文備份](raw-memory.md#備份與舊資料) 與 [組織備份契約](memory-organization.md#備份與相容)。備份的範圍**只有記憶**：NDJSON（JSON Lines，一行一筆），**不含** chunk／向量與已刪除的歷史版本；
匯入後向量由背景 worker 重建。整庫搬遷（含向量檔）不在本版範圍，見 §設計規則 6。

| 方法 | 語意 |
|---|---|
| `MetadataStore.listMemoriesForExport()` | 列出**全部未刪除**記憶；`createdAt` 由舊到新（同毫秒以 `id` 由小到大）；**不套** `listMemories` 的 500 筆上限 |

- **匯出（讀取路徑）**：`GET /memories/export` → `application/x-ndjson; charset=utf-8` 附件
  `memories-YYYYMMDD.ndjson`；一行一筆，欄位固定為
  `{schemaVersion:1, id, content, kind, scope, project, agent, sourceSession, sourceMessage, pinned,
  createdAt, supersedes}`（`sourceSession`／`sourceMessage` 為 2026-10-21 新增的來源欄位，
  見 §記憶的來源欄位）；結尾換行；0 筆時是 0 bytes 的空檔。順序與 `listMemoriesForExport` 相同。
- **匯出的遮罩語意**：匯出依當下記憶遮罩政策產生視圖；開啟時為**讀取遮罩後視圖**，與 `GET /memories` 用同一組 `maskSecrets`
  （`content`、`agent`、`project`）；資料庫裡的舊資料即使未遮罩，匯出檔也不會出現可辨識憑證的
  原文。還原的是**遮罩後內容**，不是原文；備份檔由使用者保管，可能含專案內部資訊。
- **匯入（寫入路徑）**：`POST /memories/import`，body 是原始 NDJSON
  （`application/x-ndjson`），上限 **32 MiB**（超過回 `413 PayloadTooLargeError`）。
  查詢 `dryRun=1`／`true` 只驗證與估算（其他值 `400`；未帶參數＝正式匯入）。
- **整批先驗證**：任何一行不合法 → `400` 且**完全不寫**（不做部分匯入）；回應含
  `error:{name,message}`（沿用 REST 錯誤格式）與 `invalid:[{line,reason}]`（最多前 100 筆，
  行號從 1 起算）。驗證規則與 `POST /memories` 相同：`content` 必填非空且 ≤ 8000 字元、
  `kind` ∈ fact／decision／pitfall／preference（可省略，預設 `fact`）、
  `scope` ∈ global／project／agent（可省略：有 `project` 視為 `project`，否則 `global`）、
  scope／project 組合規則一致、`agent` 必填且 ≤ 200 字元；
  `schemaVersion` 可省略（有值必須是 1）、`pinned` 可選 boolean；`sourceSession`／`sourceMessage`
  可省略（省略或 `null` → `null`；有值必須是 trim 後非空、≤ 200 字元、且非 token-like 的字串，
  否則該行不合法）；未知欄位與 `id`／`createdAt`／`supersedes` 一律忽略。
  `agent`／`project` 是查詢鍵，含 token-like 機密時該行不合法（不遮罩改寫）。
- **寫入流程**：內容先 `maskSecrets`（回應的 `redacted` 以**筆**計）→ metadata token-like 檢查
  → `addMemoryUnlessDuplicate`（重複跳過、計入 `duplicates`）→ `pinned` 時 `setMemoryPinned`
  → `memoryEmbedder.enqueue`（不阻塞回應）。**不保留** `id`／`createdAt`／`supersedes`
  （新 id、匯入時間、無歷史鏈）；`pinned` 與來源欄位（`sourceSession`／`sourceMessage`）保留。
  同批次內較早的重複也計入 `duplicates`。
- **回應**：`{dryRun, total, valid, invalid, duplicates, redacted, created, wouldCreate}`。
  dry-run 時 `created = 0`、`wouldCreate` 是預計新增數；正式匯入時 `wouldCreate = 0`。
  空檔（0 行）→ `200`＋全 0。
- **UI（面板）流程**：記憶管理面板的工具列提供「匯出備份」與「匯入備份」。匯出即下載上面
  `GET /memories/export` 產生的檔案（遮罩後視圖），由使用者自行保管，可能含專案內部資訊。
  匯入時面板先讓使用者選檔（`.ndjson`／`.jsonl`／`.txt`；**內容**一律視為 NDJSON，副檔名只影響
  檔案挑選器的顯示），選完先自動跑一次 dry-run（帶 `dryRun` 呼叫同一個端點），把預計新增／
  重複／遮罩筆數與不合法行（最多列出前 5 筆）顯示給使用者。有不合法行時面板**不提供**
  「確認匯入」按鈕（整批不會寫入）；沒有不合法行時，使用者按下「確認匯入」才送出正式匯入
  （同一端點、不帶 `dryRun`）。面板端不自行解析或拼接檔案、也不做部分寫入——「整批先驗證、
  任何一行不合法就完全不寫」的語意因此在使用者按下確認前就已可見。
- **不做**：加密、自動排程備份、串流下載、MCP 工具、chunk／向量／整庫搬遷。

## 記憶的來源欄位（2026-10-21，D4a）

讓每筆記憶能回答「誰寫的（`agent`）、哪個 session／訊息、什麼時候（`createdAt`）」。本節只加
**兩個可空欄位**與呈現，不做摘要、不呼叫模型、不改既有欄位語意。

| 公開欄位（`Memory`） | SQLite | PostgreSQL | 說明 |
|---|---|---|---|
| `sourceSession` | `source_session text`（nullable） | `source_session text` | 寫入端的 session 識別（不透明字串） |
| `sourceMessage` | `source_message text`（nullable） | `source_message text` | 寫入端的訊息識別（不透明字串） |

- **`Memory` 公開型別是 additive 擴充**：兩個欄位一律存在，值為 `string | null`；未提供或舊資料
  一律 `null`（**不是空字串**）。`NewMemory` 的這兩個欄位是**選填**（`?: string | null`），
  因此既有呼叫端不必修改。
- **不是安全邊界**：與 `agent` 一樣只是來源標記；不參與權限判斷、不參與去重 key
  （同內容＋同 `scope`／`project`／`agent` 就是重複，來源不同不算新記憶）。
- **不可變**：`MemoryPatch`（`updateMemory`／`PATCH /memories/:id`）仍只有 `scope`／`project`；
  來源欄位只在建立時寫入，之後不能改（REST 對未知欄位回 `400`）。
- **SQLite**：遷移 `0005_memory_provenance` 以 `alter table … add column` 補兩欄（先查
  `pragma table_info`，冪等）。**不重建表、不動既有資料列**，既有列兩欄為 `NULL`；沒有 down
  migration（與 0001～0004 的慣例一致）。
- **PostgreSQL**：`create table` 帶兩欄，另以 `alter table … add column if not exists` 補既有
  資料庫（冪等），與 SQLite 對齊。

### 寫入與讀取（REST／MCP）

- **`POST /memories`** 接受可選的 `sourceSession`／`sourceMessage`：
  - 未提供或 `null` → 存 `null`；
  - 必須是字串；`trim` 後儲存（前後空白沒有意義），trim 後為空 → `400`；
  - 長度上限 **200 字元**（以 trim 後計）；超過回 **`400`，不截斷**（與 `agent`／`project`
    的既有風格一致，避免靜默改寫）；
  - 含 token-like 機密 → `400`（與 `agent`／`project` 相同：識別值不遮罩改寫）。
- **讀取路徑**（`GET /memories`、`POST /memories/search` 命中、MCP `recall`／`search_memories`）
  都帶出這兩個欄位（additive），且與 `content`／`agent`／`project` 一樣再套一次 `maskSecrets`
  （防禦直接寫入 DB、繞過 REST 驗證的舊資料；正常寫入路徑已拒絕 token-like 值）；MCP `remember` 的回應也帶，但值為 `null`——MCP 工具沒有 session
  資訊，自動寫入者（D4b）走 REST 自行提供。原文來源另有 `GET /memory-sources/:id`；**沒有** `GET /memories/:id` 端點（本版現況；
  單筆讀取請用列表或召回，伺服器端以 `getMemory` 取得完整資料）。
- **匯出／匯入**：匯出列固定帶 `sourceSession`／`sourceMessage`（順序見 §記憶的匯出／匯入），
  `schemaVersion` **維持 1**；匯入時缺欄位的舊備份成功、補 `null`，帶欄位的新備份保留值
  （驗證規則同 `POST /memories`）。這是 additive 變更，舊版讀新備份時未知欄位會被忽略。

### UI（Web）

記憶列表每張卡顯示寫入者（`agent`，自動寫入者另標「（自動）」）、來源 session（縮短顯示，
完整值在 `title` 與「看來源」面板）與建立時間；「看來源」面板另列 `sourceMessage`。
工具列提供「來源」篩選：**全部**／**只看自動寫入**（`agent` 以 `opencode-plugin` 開頭）。
這個篩選純粹是顯示輔助，**不是**安全邊界。

### 契約測試

`runMetadataStoreContract` 新增一例：帶兩個欄位寫入 → `getMemory`／`listMemories`／
`listMemoriesForExport` 讀回一致；未帶或明示 `null` → `null`；`addMemoryUnlessDuplicate` 同樣
寫入且來源不在去重 key 內；`updateMemory` 不改來源。SQLite 與 PostgreSQL 兩個後端都跑同一組測試
（PostgreSQL 需 `MNEMOSHELF_PG=1`）。

## 記憶的語意化（2026-10-18）

記憶內容用**同一個多模態 embedder 的文字路徑**（`embedDocument`）產生向量，存在記憶自己的欄位。
本節只定義「產生與維護向量」；召回 API、跨專案過濾與排名見 §記憶檢索。

### 為什麼不放在 `VectorIndex`

`VectorIndex`（sqlite-vec 的 `vectors` 表）的 `root_id is null` 與 `key like 'm:%'` 都是
**KNN 之後才過濾**（post-filter）：鄰近的 chunk 向量一多，只查記憶的 top-k 可能回不到該有的記憶。
記憶召回最需要的是**先依 scope／project 精確過濾再排名**，因此改存 `memories` 自己的欄位，
讓召回端能在同一個 SQL 過濾後再算相似度（SQLite 在應用層算 cosine、PostgreSQL 用 pgvector `<=>`）。
`VectorIndex`、`vectors` 表與 `/search` 都**不變**。

### 欄位與狀態機

`Memory` 公開型別**不變**（向量不暴露在 REST／MCP 回應）；下列是 `memories` 表的實作欄位：

| 欄位 | SQLite | PostgreSQL | 說明 |
|---|---|---|---|
| `embedding` | `blob`（nullable） | `vector`（nullable、**不帶維度**） | 向量；未嵌入時為 `NULL` |
| `embedding_embedder_id` | `text`（nullable） | `text` | 產生這個向量的 embedder `info.id`；換 embedder 後視為 stale |
| `embedding_state` | `text not null default 'pending'` | 同左 | 狀態機，見下 |

`MemoryEmbeddingState`＝`"pending" | "ready" | "failed" | "too-long"`：

- `pending`：待嵌入；**新資料與既有資料的預設**（既有資料含已軟刪除者一律 `pending`，但回填只處理未刪除者）。
- `ready`：向量已產生；是否可用還要求 `embedding_embedder_id` 與目前 embedder 相符。
- `failed`：嵌入失敗，**可重試**（同一次執行內不回填；下一次 `start()` 的回填會再試）。
- `too-long`：超過 embedder 的單筆輸入上限，**永久跳過**（重試也不會成功）。

SQLite 以版本化遷移 `0003_memory_embedding` 逐欄補上（先查 `pragma table_info`，冪等）；
PostgreSQL 在 `migrate()` 以 `alter table … add column if not exists` 補欄位（冪等），並先確保
pgvector 擴充存在（`create extension if not exists vector`；與 `PgVectorIndex.migrate()` 相同要求）。
向量以 Float32Array 的 little-endian 位元組存 SQLite BLOB；PostgreSQL 以 pgvector 的文字格式綁定參數。

### `MetadataStore` 的四個方法

```ts
export type MemoryEmbeddingState = "pending" | "ready" | "failed" | "too-long";

export interface MemoryEmbeddingStats {
  total: number;   // 未刪除的記憶總數
  pending: number;
  ready: number;
  failed: number;
  tooLong: number;
  stale: number;   // state=ready 但 embedding_embedder_id != 查詢的 embedderId
}

markMemoryEmbedded(id: number, embedderId: string, vec: Float32Array): Promise<void>;
markMemoryEmbeddingFailed(id: number, reason: "failed" | "too-long"): Promise<void>;
listMemoriesNeedingEmbedding(embedderId: string, limit?: number): Promise<Memory[]>;
memoryEmbeddingStats(embedderId: string): Promise<MemoryEmbeddingStats>;
```

- **`markMemoryEmbedded`**：同一次 UPDATE 設定 `embedding`、`embedding_embedder_id` 與
  `embedding_state='ready'`，不會觀察到「ready 但沒有向量」的中間狀態。不驗證 L2 正規化
  （由 embedder 契約保證）。`embedderId` 空白或 `vec` 空／含非有限值 → 拋 `TypeError`。
- **`markMemoryEmbeddingFailed`**：把狀態設為 `failed` 或 `too-long`，**保留**既有向量與 embedder
  身分（召回端只採 `ready` 且 embedder 相符者；保留舊值便於同 embedder 重試成功時比對／診斷）。
  `reason` 非法 → 拋 `TypeError`。
- **兩者的未知 id 或已軟刪除者都是 no-op**（不拋錯、不建立資料列），與 `setMemoryPinned` 的風格一致。
- **`listMemoriesNeedingEmbedding`**：只回未刪除者；條件＝`state in ('pending','failed')` 或
  （`state='ready'` 但 embedder 不相符）；**排除 `too-long`**；排序與 `listMemories` 相同
  （`createdAt` 由新到舊、同毫秒以 `id` 決序）；`limit` 沿用 `normalizeMemoryLimit`（預設 100、上限 500、<= 0 空清單）。
- **`memoryEmbeddingStats`**：只統計未刪除者；`total = pending + ready + failed + tooLong`；
  `stale` 是 `ready` 的子集（另計、不重複進 total）。`embedding_embedder_id is null` 的 `ready` 也算 stale（防禦性）。

兩後端共用契約測試（`@mnemoshelf/core/testing` 的 `runMetadataStoreContract`）新增六例：
`markMemoryEmbedded`／stats／待嵌清單、換 embedder 的 stale 重嵌、failed 可重試與 too-long 排除、
未知與已刪除 id 的 no-op、非法輸入拋錯、待嵌清單的排序與 `limit` 邊界。

### 背景回填與重試（伺服器層）

伺服器建立 `MemoryEmbeddingWorker`（`packages/server/src/memory-embedder.ts`），
`createServer()` 監聽成功後 `start()`：

- **非阻塞**：`start()` 只啟動背景 loop；`POST /memories` 只把 id `enqueue()`，立即回 `201`，
  `supersedes` 產生的新版本同樣排入。向量在背景完成（狀態由 `pending` 變 `ready`）。
- **佇列去重**：同一 id 在「佇列中」或「處理中」重複 `enqueue()` 都會被忽略（去重保留到
  `processOne` 完成）；處理完成後再 enqueue 才會重新處理。
- **回填**：佇列空了就從 DB 抓一批需要嵌入的記憶（新到舊、每次 `batchSize`＝100 筆）。
  **同一次 `start()` 內**以 attempted 集合去重：已嘗試過的 id（含 `failed`）不會在同一輪被重抓，
  避免無限迴圈；因此 `failed` **只會在下一次 `start()`**（下一次服務啟動）再試，同一次執行內不回填。
- **回填分頁**：以 createdAt／id keyset 繼續往較舊資料讀取；前面整批失敗也不能阻擋後續 pending。
  同輪 attempted 仍避免對已失敗片段無限重試。
- **併發 1**；重試：`input-too-long` → `too-long`（不重試），其他錯誤重試至多 3 次
  （不含第一次）後標 `failed`（同一次執行不再重試，見上）。
- **換 embedder**：舊向量（`embedding_embedder_id` 不同）視為 stale，回填流程會用新 embedder 重嵌
  （受同一每次 batch 限制）。
- **`close()`**：停止拉新工作、取消重試等待、清空佇列，等目前處理中的那一筆結束後返回；
  已排隊未處理者留在 `pending`，下次啟動回填。不留 timer／hanging promise。
- **診斷**：`GET /diagnostics` 新增 additive 的 `memories` 欄位：

  ```json
  "memories": {
    "total": 0, "ready": 0, "pending": 0, "failed": 0, "tooLong": 0, "stale": 0,
    "worker": { "queued": 0, "processing": 0, "embedded": 0, "failed": 0, "tooLong": 0 }
  }
  ```

  狀態數來自 `memoryEmbeddingStats`；`worker` 是本行程累計（重啟歸零）。
  `POST /memories` 的 scope／project 正規化（省略 scope 帶 project → `project`；矛盾組合 `400`）
  也在同一次實作完成，既有呼叫端行為不回歸。

**召回端的界線**：這一節只負責「產生、保存、重試與診斷」向量；召回端點（REST／MCP）與
scope／project 的過濾排名見 §記憶檢索，且不影響 `/search` 的既有語意。

## 記憶檢索（2026-10-18）

記憶召回**不經過** `VectorIndex`（`vectors` 表），也不改 `/search`；語意與關鍵字都在
`MetadataStore` 對 `memories` 表操作，**先過濾再排名**。原因見 §記憶的語意化
「為什麼不放在 `VectorIndex`」：vec0 對 `root_id is null`／`key like` 只能在 KNN 之後過濾，
而記憶召回需要先依 scope／project 精確過濾。

### 可見範圍（`MemorySearchBucket`／`MemorySearchFilter`）

```ts
export interface MemorySearchBucket {
  scope: MemoryScope;   // global / project / agent
  /** scope=project 時：有值＝精確比對專案名；省略＝**所有專案**。 */
  project?: string;
  /** scope=agent 時必填（比對 memories.agent）。 */
  agent?: string;
}

export interface MemorySearchFilter {
  buckets?: MemorySearchBucket[];  // OR；未提供＝不限制 scope；空陣列＝沒有結果
  kind?: MemoryKind;
}
```

| bucket | SQL 條件 |
|---|---|
| `{scope:"global"}` | `scope='global'`（不得帶 project／agent） |
| `{scope:"project"}` | `scope='project'`（**所有專案**） |
| `{scope:"project", project:"p"}` | `scope='project' AND project='p'` |
| `{scope:"agent", agent:"a"}` | `scope='agent' AND agent='a'`（agent 必填非空） |

- **「所有專案」的介面表示**＝`project` scope **不帶名稱**；呼叫端不需要（也不應該）列舉專案名
  再組多個 bucket。
- `kind` 精確比對；所有查詢永遠排除 `deleted_at is not null`。
- 非法 bucket（scope 不合法、`global` 帶 `project`／`agent`、`agent` 缺 `agent` 或空白、
  `project` 非字串）→ 拋 `TypeError`；兩後端以 `normalizeMemorySearchFilter` 共用同一套驗證。
- `filter.buckets` 未提供＝不限制 scope；**空陣列＝沒有可見範圍**（回空清單，不是「不過濾」）。

### 兩個方法

```ts
searchMemoriesByVector(
  queryVec: Float32Array, embedderId: string, filter: MemorySearchFilter, k: number,
): Promise<{ id: number; score: number }[]>;

searchMemoriesKeyword(query: string, filter: MemorySearchFilter, k: number): Promise<{ id: number; rank: number }[]>;
```

- **`searchMemoriesByVector`**：只取 `embedding_state='ready'` 且 `embedding_embedder_id = embedderId`
  的未刪除記憶；SQL 先套 filter，再算 cosine similarity。`score` 為 cosine（[-1,1]），排序
  **score 降冪、同分 id 升冪**。`queryVec` 必須非空且只含有限值；與資料維度不同 → `TypeError`
  （不得默默跳過）；`k` <= 0 回空、上限 500（`normalizeMemorySearchK`）。
- **`searchMemoriesKeyword`**：沿用既有 `Intl.Segmenter` 斷詞與 FTS（SQLite `memories_fts`、
  PostgreSQL `tsv`）；同一組 filter 先在 SQL 套用；**只查記憶、不混 chunk**；空查詢／無可搜尋詞
  回空；`k` 邊界同上；回傳 `rank` 1..n，同分以 id 決勝（可重現）。
- 兩者都在**排名前**套用 filter：不會出現「先取 top-k 再過濾」而少給符合條件的記憶。

### 兩後端實作

- **SQLite（預設）**：先以 SQL（`deleted_at`／`ready`／embedder／bucket／kind）撈候選列，於應用層
  解碼 BLOB 並以 cosine 精確排序（千～萬筆量級可接受；無 ANN）。關鍵字走 `memories_fts` 的 `bm25`。
- **PostgreSQL**：同一句 SQL 內用 `embedding <=> $1::vector`（精確距離）排序；為維持「維度不符 →
  `TypeError`」的跨後端語意，先以 `vector_dims()` 預檢一次（向量欄位不帶維度）。關鍵字走
  `tsv`＋GIN 的 `ts_rank`。
- 契約測試（`runMetadataStoreContract`）新增五例：bucket 過濾（global／project／所有專案／agent／
  kind／空 bucket／未提供）、ready／embedder 相符與失敗狀態排除（含同分 id 決勝）、`k` 邊界與
  維度不符、關鍵字過濾／排除 deleted／不混 chunk／rank 連續、非法 bucket 拋錯。
  SQLite 必跑；PostgreSQL 同一組測試（`MNEMOSHELF_PG=1`）。

### 召回 API 的行為（REST／MCP；伺服器層）

`POST /memories/search` 與 MCP `search_memories` 共用 `packages/server/src/memory-search.ts`：

- **預設範圍（未指定 `scope`）**：本專案＋`global`（＋呼叫端明確提供的 agent）；未提供 `project`
  且未 `includeAllProjects` → `400`（避免不明確的召回範圍）。`includeAllProjects=true` →
  `global`＋所有專案（＋明確提供的 agent）。
- **明確指定 `scope` 時只回該 scope**：`global` → 只 global；`agent` → 只 agent
  （必須提供 agent）；`project` → 只 project（以 `project` 指定，或 `includeAllProjects=true`
  代表所有專案）——**不包含 `global`，也不包含自己的 agent**。`scope=project` 同時帶 `project`
  與 `includeAllProjects=true` 時 **`project` 優先**（`includeAllProjects` 被忽略）。
- **語意優先**：以 `embedder.embedQuery`＋`searchMemoriesByVector` 取得語意結果並依 cosine 排序；
  `minScore`（0..1）只過濾語意結果。只有語意結果不足 `k` 時才以 `searchMemoriesKeyword` **補足**
  （以 id 去重、附加在後、**不重排**語意結果）。
- **降級**：以「**可用 ready＝`ready − stale`**」判斷；`<= 0` →
  `degraded: true`＋`degradedReason: "no-embeddings"`（換 embedder 後、回填完成前全部 ready 都是
  stale 也算，此時連模型都不載入）。有可用向量但 `embedQuery` 失敗（**包含查詢過長的
  `input-too-long`**）→ `degraded: true`＋`degradedReason: "embedder-unavailable"`；兩者都改用
  關鍵字結果。這與 `/search` 不同：`/search` 對 `input-too-long` 回 `400`，召回有降級路徑因此回 `200`。
- 命中回傳完整記憶欄位（與 `GET /memories` 一致）＋`rank`／`score`／`source`（`semantic`／`keyword`；
  關鍵字以 `1/rank` 當排序輔助分數）。`k` 預設 10；**大於 100 會靜默夾到 100**（不是 `400`；
  REST／MCP；store 層上限 500）。
- 不變更 `/search`、`VectorIndex`、檔案索引管線與記憶寫入路徑。

## 全文檢索與中文

SQLite FTS5 預設斷詞對中文效果差；三字元的 `trigram` tokenizer 對兩字詞查詢無效。
採用哪種中文處理方式由實測決定（候選：trigram 加短查詢 LIKE 備援、二元組預處理、
`Intl.Segmenter` 斷詞後交給 `unicode61`）。這是 `MetadataStore` 的實作細節，
**不得洩漏到介面**。PostgreSQL 後端的中文檢索路線與 trigram 退化行為見 §PostgreSQL 後端。

## PostgreSQL 後端

`MetadataStore` 與 `VectorIndex` 的第二個實作（`@mnemoshelf/storage-pg`，PostgreSQL ＋ pgvector）。
**行為細節與實測依據以 `packages/storage-pg/README.md` 為準**；本節只記契約層要點。

- **同一組契約測試**：兩個 port 都讓 `@mnemoshelf/core/testing` 的 `runMetadataStoreContract`、
  `runVectorIndexContract` 通過；換後端不動 core，也不改本文件的介面。
- **需求**：PostgreSQL 13 以上、**pgvector ≥ 0.8.0**（帶 `rootIds` 過濾的 KNN 需要
  `hnsw.iterative_scan`，0.8.0 起提供）。
- **向量索引**：HNSW（`vector_cosine_ops`），可在空表建立（`migrate()` 冪等、不必等資料）。
- **過濾與 iterative scan**：pgvector 的近似索引是**先掃描、後過濾**；帶 `rootIds` 的查詢若不開
  iterative scan，預設 `ef_search=40` 下 `LIMIT 10` 可能只回 7 列（實測），直接違反「過濾在 KNN
  之內生效」的契約。因此每個查詢前在**同一交易內**執行 `SET LOCAL hnsw.iterative_scan = strict_order`。
- **上限語意（`max_scan_tuples`）**：iterative scan 仍受 `hnsw.max_scan_tuples`（預設 **20000**）
  限制——它限制掃描的候選列數。若某個 root 的向量在整體排名中非常稀疏、候選超過上限仍不足 k 筆，
  查詢就會**回不滿 k 列**。需要時調大 `hnsw.max_scan_tuples`（與 `hnsw.scan_mem_multiplier`）。
  這是 PostgreSQL 後端相對 SQLite（vec0 partition key 精確過濾）在極端選擇性下的已知落差。
- **中文全文檢索**：沿用 SQLite 端的「應用層 `Intl.Segmenter` 斷詞」路線——寫入時存斷詞後文字，
  PostgreSQL 端用 generated `tsvector('simple', …)` ＋ GIN。兩後端因此共用同一套斷詞程式碼，
  中英文 FTS 行為一致。

### 與 SQLite 的差異摘要

| 面向 | SQLite（預設） | PostgreSQL（pgvector） |
|---|---|---|
| 向量索引 | sqlite-vec 暴力掃描（無 ANN） | HNSW 近似索引（＋ iterative scan） |
| 過濾語意 | vec0 partition key，精確過濾 | index scan 後才過濾，靠 iterative scan 補足；仍受 `max_scan_tuples` 上限 |
| 關鍵字排名方向 | `bm25()`（越小越前） | `ts_rank`（越大越前）——adapter 統一方向 |
| trigram 退化行為 | FTS5 `trigram` 對 <3 字元查詢**回 0 命中** | `pg_trgm` 對 2 字中文**結果正確但退化成全表掃描**（無索引加速） |
| tie 排序 | rowid＝插入序（覆寫＝delete＋insert） | 無保證；adapter 以單調 `seq` ＋ `ORDER BY distance, seq` 重現 |
| 中文處理 | 應用層斷詞（方案 S） | 同一套應用層斷詞 ＋ `tsvector('simple')` ＋ GIN |

**`trigram` 的失效方式不同**：SQLite FTS5 `trigram` 對 2 字查詢回 0 命中；pg_trgm ＋ `LIKE` 對 2 字
中文結果仍正確、只是用不到索引。兩者的「失效方式」不同，因此**不能直接照搬 SQLite 的 `LIKE` 備援設計**
到 PostgreSQL 端。

> **實測狀態（誠實標示）**：本文件 2026-10-19 新增的記憶方法（去重、legacy 正規化、硬刪除、
> `listMemoriesForExport`）與匯出／匯入端點，PostgreSQL 端有實作與同一組契約測試，但測試需
> `MNEMOSHELF_PG=1`（Docker／PG 環境）才執行；本版開發機沒有 Docker，**PG 尚未實跑**，
> 不能宣稱已在 PostgreSQL 驗證。SQLite 端為預設路徑、已實跑。

## 規模參考

sqlite-vec 目前只有暴力掃描（無 ANN 索引）。以 512 維 float32 計，每筆向量約 2 KB。
資料量超過數十萬筆後，查詢延遲需實測；超過約百萬筆時應考慮有 ANN 索引的後端。
