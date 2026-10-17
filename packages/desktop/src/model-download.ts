/**
 * 真正抓模型的檔案（transformers.js 的 `from_pretrained()`，帶進度回呼）。
 *
 * 這裡**刻意**照 `packages/embedder-transformers` 的 `loadModel()` 順序做同一件事
 * （AutoConfig → `audio_config = null` → AutoProcessor → AutoModel，dtype q4、device cpu）：
 * 只有用同一組參數，預先下載的檔案才會正好是 embedder 之後要用的那一組。
 * 兩個時期的檔案清單必須相同，這件事由打包產物的自動流程實測（下載後 vs 跑完一次索引後）。
 *
 * `session_options.enableCpuMemArena = false` 也**必須與 embedder 一致**（見 `createBackend()`）：
 * 這裡建的是一次**真推論**的 session（下載後驗證模型能載入並跑完），不是只有讀檔案。
 * ONNX Runtime 的 CPU arena 在請求超過目前 chunk 時會把 chunk 以 2 的冪次往上翻，
 * 一次超過 1 GiB 的請求因而變成 ≥2 GiB 的單一配置，而這個大小在 Chromium／Electron 內
 * 會被 PartitionAlloc **直接終止行程**（整個 app 閃退）。少了這個開關，全新安裝在 macOS
 * 的「下載後驗證」階段就可能踩到與索引時同一個崩潰；而且兩個時期的 options 不一致
 * 會讓之後的診斷更難（同一顆地雷時有時無）。
 *
 * `session_options.enableMemPattern = false` 同理，而且是**同一族死路的殘餘配置點**：
 * arena 關掉之後，ORT 的 memory pattern 仍會在 `ExecutionFrame` 建構子**一次**配置
 * 「整個 graph 中間張量的峰值總和」；該聚合值隨單塊長度成長，8k token 的窗實測可到
 * 2.28 GiB，越過 PartitionAlloc 的單一配置上限（2 GiB − 2 MiB）即整個 app 閃退。
 * 兩個開關都必須與 embedder 的 `createBackend()` 一模一樣。
 * （`AutoModel.from_pretrained` 會把同一組 options 複製給每個 session——文字與視覺都吃到。）
 *
 * 為什麼不在 embedder 上加進度回呼：本卡的允許修改範圍不含 `packages/embedder-transformers`
 * （那是既有套件），因此進度整合放在桌面殼這一側。
 */
import { AutoConfig, AutoModel, AutoProcessor, env } from "@huggingface/transformers";
import type { RawProgressInfo } from "./model-progress.js";
import type { ModelProfile } from "./model-profile.js";

/** 下載階段需要的輸入。 */
export interface DownloadModelOptions {
  profile: ModelProfile;
  /** 模型快取目錄（transformers.js 的 `env.cacheDir`）。 */
  modelDir: string;
  /** 進度回呼（轉送給呼叫端聚合）。 */
  onProgress: (info: RawProgressInfo) => void;
}

/** 模型物件的最小介面（只需要能釋放）。 */
interface DisposableModel {
  dispose?: () => Promise<unknown>;
}

/**
 * 建 session 時共用的 ONNX Runtime options。
 *
 * 單獨寫成常數是為了讓「每一個 session 建立點都帶同一組 options」變成看得見的事實：
 * 這個模組目前只有一個建立點，之後若多出第二個（例如分開啟用視覺編碼器），
 * 沿用同一個常數即可，不會再出現「其中一條路徑忘了帶」的落差。
 */
export const MODEL_SESSION_OPTIONS = {
  enableCpuMemArena: false,
  enableMemPattern: false,
} as const;

/**
 * 抓齊模型檔案。**不**回傳模型：載入一次只為了把檔案抓下來，之後立刻釋放，
 * 真正要用的那份由 embedder 自己載入（那時全部命中快取，不會再連網）。
 */
export async function downloadModelFiles(options: DownloadModelOptions): Promise<void> {
  const { profile, modelDir, onProgress } = options;

  // 必須在任何模型物件建立之前設定（預設值會落在唯讀的 app.asar 內）。
  env.cacheDir = modelDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  const progress_callback = (info: unknown): void => {
    onProgress(info as RawProgressInfo);
  };
  const shared = { progress_callback };

  const config = await AutoConfig.from_pretrained(profile.modelId, shared);
  // 只載文字＋圖片：embedder 也是這樣做，否則會多抓一份音訊編碼器。
  (config as unknown as { audio_config: unknown }).audio_config = null;

  await AutoProcessor.from_pretrained(profile.modelId, shared);

  const model = (await AutoModel.from_pretrained(profile.modelId, {
    config,
    device: "cpu",
    dtype: profile.dtype,
    progress_callback,
    // 見檔頭說明：與 embedder 的 createBackend() 保持一致（關閉 CPU arena）。
    session_options: { ...MODEL_SESSION_OPTIONS },
  })) as unknown as DisposableModel;

  if (typeof model.dispose === "function") {
    await model.dispose();
  }
}
