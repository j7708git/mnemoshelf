// 測試語料：全部為合成資料（本 spike 自行撰寫），不含任何使用者私人檔案內容。
// 文字每組 6 句：4 句繁體中文 + 1 句英文 + 1 句程式碼片段，滿足任務卡要求（至少 5 句）。

export const QUERIES = [
  { id: "q_zh_travel", lang: "zh", kind: "text", text: "員工旅遊補助的申請流程是什麼？" },
  { id: "q_zh_sqlite", lang: "zh", kind: "text", text: "要怎麼用 SQLite 做檔案的全文檢索？" },
  { id: "q_zh_park", lang: "zh", kind: "text", text: "台北市有哪些適合帶小孩去的公園？" },
  { id: "q_zh_coffee", lang: "zh", kind: "text", text: "沖咖啡的時候要怎麼降低苦味？" },
  { id: "q_en_renew", lang: "en", kind: "text", text: "How do I renew a passport that is about to expire?" },
  {
    id: "q_code_sql",
    lang: "code",
    kind: "code",
    text: "SELECT path, score FROM chunks WHERE root_id = ? ORDER BY score DESC LIMIT 20;",
  },
];

export const DOCUMENTS = [
  {
    id: "d_zh_travel",
    lang: "zh",
    kind: "text",
    title: "員工旅遊補助辦法",
    text: "申請流程分三步：先由部門主管在系統填寫旅遊計畫，再檢附收據與參加名單送人事單位核銷，最後由財務於次月匯款。每人每年補助上限為新台幣八千元。",
  },
  {
    id: "d_zh_sqlite",
    lang: "zh",
    kind: "text",
    title: "SQLite 全文檢索筆記",
    text: "SQLite 內建 FTS5 虛擬表，可以對檔案內容建立全文索引；若要做語意檢索，則另外用 sqlite-vec 擴充儲存向量，兩者以檔案路徑為主鍵對齊。",
  },
  {
    id: "d_zh_park",
    lang: "zh",
    kind: "text",
    title: "親子公園清單",
    text: "大安森林公園有沙坑與大草皮，適合推嬰兒車；青年公園的共融式遊具可以讓不同年齡的小孩一起玩；河濱公園則有自行車道，週末人潮較多。",
  },
  {
    id: "d_zh_coffee",
    lang: "zh",
    kind: "text",
    title: "手沖咖啡筆記",
    text: "想降低苦味可以調低水溫到攝氏八十八度左右、縮短萃取時間，或把研磨度放粗一點；深焙豆特別容易萃出苦澀味，建議減少注水次數。",
  },
  {
    id: "d_en_renew",
    lang: "en",
    kind: "text",
    title: "Passport renewal checklist",
    text: "Renewing an expiring passport requires filling out the application form, submitting a recent photo, paying the fee, and mailing the old passport to the issuing office.",
  },
  {
    id: "d_code_typescript",
    lang: "code",
    kind: "code",
    title: "embedder.ts",
    text: "export async function embedImage(pixels: Float32Array): Promise<Float32Array> {\n  const out = await model.run({ pixel_values: pixels });\n  return l2normalize(truncate(out.sentence_embedding, 512));\n}",
  },
];

/** 約 500 token 的長文件，用於量測長文延遲（合成內容，描述本機檔案索引的設計）。 */
export const LONG_DOCUMENT = `本機語意檔案總管的索引流程可以分成四個階段。第一階段是掃描，使用者把想要納入的資料夾加入之後，系統會以遞迴方式列出檔案，並依照副檔名與 magic bytes 判斷類型；掃描時會跳過隱藏目錄、版本控制目錄與超過大小上限的檔案，並且記錄每個檔案的修改時間與大小，以便之後做增量更新。第二階段是切塊，文字檔會依段落切成大約數百字元的區塊，並保留重疊內容，避免句子被切斷之後語意不完整；程式碼則依函式或類別邊界切塊，讓每個區塊仍然是一個語意單位。第三階段是嵌入，每個區塊會透過多模態嵌入模型轉成同一個向量空間中的向量，圖片直接嵌入，文件則以檔名當作標題、內容當作正文，套用文件前綴之後再嵌入。第四階段是寫入索引，向量存進 sqlite-vec 的虛擬表，文字欄位存進 FTS5 的虛擬表，兩者共用同一組區塊識別碼，這樣查詢的時候可以同時做關鍵字比對與語意排序，再把兩份分數融合成最後的排名。增量更新時，系統比對上次掃描的結果，只重新處理新增、修改與刪除的檔案；刪除檔案時要一併清掉它的所有區塊與向量，避免查詢到已經不存在的內容。整個流程都只在使用者明確加入的資料夾裡面進行，任何不在清單中的路徑都會被拒絕，這是這個工具最重要的隱私保證。當索引完成之後，使用者可以用一段文字描述來搜尋圖片、文件與程式碼，例如輸入一段中文敘述，就能找到相關的截圖或說明文件，也可以反過來用圖片去尋找文字說明。為了讓記憶可以跨工具共用，索引與查詢都會透過本機的服務介面提供，其他的代理程式可以透過協定讀寫同一份記憶，而不需要知道檔案實際放在哪裡。`;
