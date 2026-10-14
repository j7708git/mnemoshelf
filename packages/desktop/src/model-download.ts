/**
 * 真正抓模型的檔案（transformers.js 的 `from_pretrained()`，帶進度回呼）。
 *
 * 這裡**刻意**照 `packages/embedder-transformers` 的 `loadModel()` 順序做同一件事
 * （AutoConfig → `audio_config = null` → AutoProcessor → AutoModel，dtype q4、device cpu）：
 * 只有用同一組參數，預先下載的檔案才會正好是 embedder 之後要用的那一組。
 * 兩個時期的檔案清單必須相同，這件事由打包產物的自動流程實測（下載後 vs 跑完一次索引後）。
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
  })) as unknown as DisposableModel;

  if (typeof model.dispose === "function") {
    await model.dispose();
  }
}
