// 影片 A2 語料定義（單一真相）：6 支品質影片的視覺場景與音軌事件、24 題查詢、4 個負對照。
// 版本 v1，固定 seed；所有時間範圍在生成後由 generate-quality.mjs 依實際 TTS 長度與場景邊界寫出。
// 檔名一律無語義（v01..v06/n01..n04），查詢與時段只存在 labels/*.json 與 notes 研究筆記。

/** 本機 TTS 台詞（只存在 .tmp 與 notes；不寫進語料檔名）。 */
export const TTS_LINES = {
  t01: { voice: "zh-TW", text: "把番茄切塊，加入雞蛋，最後加鹽調味。" },
  t02: { voice: "zh-TW", text: "列車即將進站，請旅客站在黃線後方等候。" },
  t03: { voice: "zh-TW", text: "明天早上九點開設計審查會議，記得帶圖紙。" },
  t04: { voice: "zh-TW", text: "市場早上六點開始營業，非常熱鬧。" },
  t05: { voice: "en-US", text: "The interview is scheduled for next Tuesday at the downtown office." },
  t06: { voice: "en-US", text: "The library is quiet in the afternoon." },
  t07: { voice: "en-US", text: "The concert starts at eight in the evening." },
  t08: { voice: "en-US", text: "The bakery sells fresh bread every morning." },
};

/**
 * 品質影片定義。
 * visual[].motif 由 generate-quality.mjs 的 RENDERERS 決定畫面；
 * audio[] 的 speech 事件以 10 秒音訊片段為單位置中（chunk = 片段索引），env 事件用絕對秒數。
 */
export const VIDEOS = [
  {
    id: "v01",
    durationSeconds: 36,
    seed: 1101,
    visual: [
      { id: "v01-s1", start: 0, end: 8, motif: "starry-moon", desc: "深藍星空，黃色圓形緩慢橫移" },
      { id: "v01-s2", start: 8, end: 16, motif: "red-triangles", desc: "黑底紅色三角形脈動（干擾）" },
      { id: "v01-s3", start: 16, end: 24, motif: "green-checker", desc: "綠色棋盤格水平滾動（干擾）" },
      { id: "v01-s4", start: 24, end: 30, motif: "blue-bars", desc: "白底藍色橫條下降（干擾）" },
      { id: "v01-s5", start: 30, end: 36, motif: "navy-heart", desc: "尾段事件：深藍底紅色愛心脈動" },
    ],
    audio: [
      { id: "v01-a1", kind: "env", env: "rain", start: 0.5, end: 9.5, desc: "雨聲（chunk 0–10）" },
      { id: "v01-a2", kind: "speech", tts: "t01", chunk: 1, desc: "中文烹飪說明" },
      { id: "v01-a3", kind: "silence", start: 20, end: 30, desc: "整段靜音（chunk 2）" },
      { id: "v01-a4", kind: "env", env: "heartbeat", start: 30.5, end: 35.5, desc: "低頻心跳（未查詢干擾）" },
    ],
  },
  {
    id: "v02",
    durationSeconds: 32,
    seed: 1202,
    visual: [
      { id: "v02-s1", start: 0, end: 10, motif: "hazard-stripes", desc: "黃黑條紋水平移動" },
      { id: "v02-s2", start: 10, end: 18, motif: "black", desc: "全黑畫面（8 秒）" },
      { id: "v02-s3", start: 18, end: 26, motif: "rainbow", desc: "彩虹漸層緩慢變化" },
      { id: "v02-s4", start: 26, end: 32, motif: "purple-circles", desc: "紫圓脈動（干擾）" },
    ],
    audio: [
      { id: "v02-a1", kind: "silence", start: 0, end: 10, desc: "整段靜音（chunk 0）" },
      { id: "v02-a2", kind: "speech", tts: "t02", chunk: 1, desc: "中文車站廣播" },
      { id: "v02-a3", kind: "speech", tts: "t05", chunk: 2, desc: "英文面試時間" },
      { id: "v02-a4", kind: "env", env: "alarm", start: 30.2, end: 31.9, desc: "警報短音（未查詢干擾）" },
    ],
  },
  {
    id: "v03",
    durationSeconds: 28,
    seed: 1303,
    visual: [
      { id: "v03-s1", start: 0, end: 8, motif: "tomato-circles", desc: "奶油底紅色圓形脈動" },
      { id: "v03-s2", start: 8, end: 18, motif: "falling-white-dots", desc: "黑底白點落下" },
      { id: "v03-s3", start: 18, end: 28, motif: "green-triangles-rising", desc: "綠三角上升（干擾）" },
    ],
    audio: [
      { id: "v03-a1", kind: "speech", tts: "t03", chunk: 0, desc: "中文設計審查會議（與畫面不一致）" },
      { id: "v03-a2", kind: "silence", start: 10, end: 20, desc: "整段靜音（chunk 1）" },
      { id: "v03-a3", kind: "env", env: "knock", start: 20.5, end: 27.5, desc: "敲門聲（chunk 2）" },
    ],
  },
  {
    id: "v04",
    durationSeconds: 34,
    seed: 1404,
    visual: [
      { id: "v04-s1", start: 0, end: 9, motif: "rain-lines", desc: "深藍底淺藍垂直線落下" },
      { id: "v04-s2", start: 9, end: 17, motif: "gray-flat", desc: "全灰靜止（無事件）" },
      { id: "v04-s3", start: 17, end: 25, motif: "flashing-circles", desc: "白底深色圓快速閃爍" },
      { id: "v04-s4", start: 25, end: 34, motif: "purple-waves", desc: "紫底白波浪線（干擾）" },
    ],
    audio: [
      { id: "v04-a1", kind: "env", env: "waves", start: 0.5, end: 9.5, desc: "海浪聲（與雨畫面不一致）" },
      { id: "v04-a2", kind: "silence", start: 10, end: 20, desc: "整段靜音（chunk 1）" },
      { id: "v04-a3", kind: "speech", tts: "t06", chunk: 2, desc: "英文圖書館安靜" },
      { id: "v04-a4", kind: "env", env: "heartbeat", start: 30.5, end: 33.5, desc: "低頻心跳（未查詢干擾）" },
    ],
  },
  {
    id: "v05",
    durationSeconds: 30,
    seed: 1505,
    visual: [
      { id: "v05-s1", start: 0, end: 7, motif: "orange-flames", desc: "黑底橘色火焰閃爍" },
      { id: "v05-s2", start: 7, end: 15, motif: "black", desc: "全黑畫面（8 秒）" },
      { id: "v05-s3", start: 15, end: 23, motif: "squares-diagonal", desc: "藍底黃方塊斜向移動（干擾）" },
      { id: "v05-s4", start: 23, end: 30, motif: "lightning", desc: "黑底白色閃電閃爍" },
    ],
    audio: [
      { id: "v05-a1", kind: "speech", tts: "t07", chunk: 0, desc: "英文音樂會時間（與火焰畫面不一致）" },
      { id: "v05-a2", kind: "env", env: "alarm", start: 10.5, end: 19.5, desc: "警報聲（與黑畫面不一致）" },
      { id: "v05-a3", kind: "silence", start: 20, end: 22.5, desc: "短暫靜音" },
      { id: "v05-a4", kind: "speech", tts: "t04", chunk: 2, desc: "中文市場營業（與閃爍畫面不一致）" },
    ],
  },
  {
    id: "v06",
    durationSeconds: 26,
    seed: 1606,
    visual: [
      { id: "v06-s1", start: 0, end: 8, motif: "black-diagonals", desc: "白底黑色粗斜線掃過" },
      { id: "v06-s2", start: 8, end: 16, motif: "purple-stars", desc: "紫底黃色星星旋轉（干擾）" },
      { id: "v06-s3", start: 16, end: 26, motif: "redblue-squares", desc: "紅藍方塊交替閃爍" },
    ],
    audio: [
      { id: "v06-a1", kind: "speech", tts: "t08", chunk: 0, desc: "英文麵包店早晨" },
      { id: "v06-a2", kind: "silence", start: 10, end: 20, desc: "整段靜音（chunk 1）" },
      { id: "v06-a3", kind: "env", env: "birds", start: 20.5, end: 25.5, desc: "鳥鳴（chunk 2）" },
    ],
  },
];

/** 視覺 12 題（中 6／英 6）。命中＝同檔、video track、片段與 sceneId 標註時段重疊。 */
export const VISUAL_QUERIES = [
  { id: "V01", lang: "zh", file: "v01.mp4", sceneId: "v01-s1", prompt: "深藍色星空背景上有一顆黃色圓形緩慢移動" },
  { id: "V02", lang: "zh", file: "v01.mp4", sceneId: "v01-s5", prompt: "影片最後出現紅色愛心形狀在深藍背景上脈動" },
  { id: "V03", lang: "en", file: "v02.mp4", sceneId: "v02-s1", prompt: "Yellow and black horizontal stripes scrolling across the screen" },
  { id: "V04", lang: "en", file: "v02.mp4", sceneId: "v02-s3", prompt: "A rainbow colored gradient slowly changing across the picture" },
  { id: "V05", lang: "zh", file: "v03.mp4", sceneId: "v03-s1", prompt: "奶油色背景上有多個紅色圓形不斷脈動" },
  { id: "V06", lang: "en", file: "v03.mp4", sceneId: "v03-s2", prompt: "Small white dots falling against a black background" },
  { id: "V07", lang: "zh", file: "v04.mp4", sceneId: "v04-s1", prompt: "深藍背景上有淺藍色垂直線條像下雨一樣落下" },
  { id: "V08", lang: "en", file: "v04.mp4", sceneId: "v04-s3", prompt: "Dark circles flashing rapidly on a white background" },
  { id: "V09", lang: "zh", file: "v05.mp4", sceneId: "v05-s1", prompt: "黑色背景上橘色火焰不斷閃爍" },
  { id: "V10", lang: "en", file: "v05.mp4", sceneId: "v05-s4", prompt: "White lightning bolt shapes flashing on a black background" },
  { id: "V11", lang: "en", file: "v06.mp4", sceneId: "v06-s1", prompt: "Thick black diagonal lines sweeping across a white background" },
  { id: "V12", lang: "zh", file: "v06.mp4", sceneId: "v06-s3", prompt: "紅色和藍色方塊交替閃爍" },
];

/** 音軌 12 題（中 6／英 6）。命中＝同檔、audio track、片段與事件標註時段重疊。 */
export const AUDIO_QUERIES = [
  { id: "A01", lang: "zh", file: "v01.mp4", eventId: "v01-a1", prompt: "持續下雨的沙沙聲" },
  { id: "A02", lang: "zh", file: "v01.mp4", eventId: "v01-a2", prompt: "番茄炒蛋的烹飪做法，最後加鹽調味" },
  { id: "A03", lang: "en", file: "v02.mp4", eventId: "v02-a2", prompt: "A train arriving at the station, passengers waiting behind the yellow line" },
  { id: "A04", lang: "en", file: "v02.mp4", eventId: "v02-a3", prompt: "An interview scheduled next Tuesday at the downtown office" },
  { id: "A05", lang: "zh", file: "v03.mp4", eventId: "v03-a1", prompt: "明天早上九點開設計審查會議，記得帶圖紙" },
  { id: "A06", lang: "en", file: "v03.mp4", eventId: "v03-a3", prompt: "Someone knocking repeatedly on a wooden door" },
  { id: "A07", lang: "zh", file: "v04.mp4", eventId: "v04-a1", prompt: "海浪拍打的聲音" },
  { id: "A08", lang: "en", file: "v04.mp4", eventId: "v04-a3", prompt: "A quiet library in the afternoon" },
  { id: "A09", lang: "en", file: "v05.mp4", eventId: "v05-a1", prompt: "A concert starting at eight in the evening" },
  { id: "A10", lang: "zh", file: "v05.mp4", eventId: "v05-a4", prompt: "市場早上六點開始營業，非常熱鬧" },
  { id: "A11", lang: "en", file: "v06.mp4", eventId: "v06-a1", prompt: "A bakery selling fresh bread every morning" },
  { id: "A12", lang: "zh", file: "v06.mp4", eventId: "v06-a3", prompt: "鳥鳴聲" },
];

/**
 * 4 個負對照 fixture（不在 6 支品質影片內）：全部為「無可檢索事件」的死內容。
 * 判定：24 題任一題的 Top-1 不得是這 4 支；亦不得出現在 Top-3 的完美命中位置。
 * 依據音訊驗收慣例（靜音 f07 負對照「不得成為任一查詢 Top-1」）。
 */
export const NEGATIVE_CONTROLS = [
  { id: "n01", file: "n01.mp4", durationSeconds: 20, seed: 2101, visual: "black", audio: "silent", desc: "全黑畫面＋靜音音軌" },
  { id: "n02", file: "n02.mp4", durationSeconds: 20, seed: 2102, visual: "gray-flat", audio: "none", desc: "全灰靜止＋無音軌" },
  { id: "n03", file: "n03.mp4", durationSeconds: 20, seed: 2103, visual: "black", audio: "tone440", desc: "全黑畫面＋440 Hz 純音" },
  { id: "n04", file: "n04.mp4", durationSeconds: 20, seed: 2104, visual: "slow-gradient", audio: "silent", desc: "極緩慢灰階漸層（無事件）＋靜音" },
];
