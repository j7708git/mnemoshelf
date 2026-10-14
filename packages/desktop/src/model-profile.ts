/**
 * 桌面殼的「模型 profile」：首次啟動要預先下載什麼、以及「模型已經就緒」怎麼判定。
 *
 * 為什麼需要它：模型是 lazy 載入的（第一次索引才載），使用者第一次啟動時會卡在下載而看不到進度。
 * 桌面殼改成：啟動時先確認模型是否就緒，沒就緒就在 UI 顯示下載進度（可重試）。
 *
 * 這裡的常數必須與 embedder 實際載入的一致（模型 id、dtype、必要檔案），否則會變成
 * 「預先下載的檔案不是 embedder 要用的」→ 第一次索引時又下載一次。以兩道防線守住：
 *   1. `DEFAULT_MODEL_ID`／dtype 直接沿用 embedder 的公開設定（dtype 預設 q4 是 embedder 的
 *      `DEFAULT_DTYPE`，本檔在 `MODEL_PROFILE` 旁明文註記）。
 *   2. 打包產物的自動流程會比對「預先下載完成後」與「跑完一次索引後」的模型目錄檔案清單，
 *      兩者必須完全相同（見 `scripts/smoke.mjs` 的 `index` 情境）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_MODEL_ID, type TransformersDtype } from "@mnemoshelf/embedder-transformers";

/** 預先下載用的模型設定。 */
export interface ModelProfile {
  /** Hugging Face 模型 id（＝embedder 的 `DEFAULT_MODEL_ID`）。 */
  modelId: string;
  /** 逐元件 dtype；與 embedder 的預設 dtype `q4` 相同（型別沿用 embedder 允許的集合）。 */
  dtype: { model: TransformersDtype; vision_encoder: TransformersDtype };
  /** 「可用」所需的最小檔案集合（相對 `<modelDir>/<modelId>`，POSIX 分隔）。 */
  essentialFiles: readonly string[];
}

/** 本專案目前唯一的模型設定（與 `packages/embedder-transformers` 的預設一致）。 */
export const MODEL_PROFILE: ModelProfile = {
  modelId: DEFAULT_MODEL_ID,
  dtype: { model: "q4", vision_encoder: "q4" },
  essentialFiles: [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "preprocessor_config.json",
    "onnx/model_q4.onnx",
    "onnx/model_q4.onnx_data",
    "onnx/vision_encoder_q4.onnx",
    "onnx/vision_encoder_q4.onnx_data",
  ],
};

/**
 * transformers.js（`FileCache.put`）的暫存檔命名：`<最終檔名>.tmp.<pid>.<rand>`。
 * 下載中斷（程序被砍）時會留下這種檔案，重試時不會用到，可以安全清掉。
 */
const STALE_TEMP_PATTERN = /\.tmp\.\d+\.[0-9a-z]+$/;

export function isStaleTempFile(fileName: string): boolean {
  return STALE_TEMP_PATTERN.test(fileName);
}

/** 模型檔案的落地目錄：`<modelDir>/<modelId>`（與 transformers.js 的 cache key 一致）。 */
export function modelRootDir(modelDir: string, profile: ModelProfile): string {
  return path.join(path.resolve(modelDir), ...profile.modelId.split("/"));
}

/** 一次目錄掃描的結果。 */
export interface ModelDirScan {
  /** 相對模型目錄的檔案大小（POSIX 分隔）。 */
  files: Record<string, number>;
  totalBytes: number;
  /** 上次中斷留下的暫存檔（相對模型目錄）。 */
  staleTempFiles: string[];
}

/** 遞迴掃描模型目錄；目錄不存在時回空的結果。 */
export async function scanModelDir(dir: string): Promise<ModelDirScan> {
  const files: Record<string, number> = {};
  const staleTempFiles: string[] = [];
  let totalBytes = 0;

  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isStaleTempFile(entry.name)) {
        staleTempFiles.push(relative);
        continue;
      }
      const stat = await fs.stat(full).catch(() => null);
      if (stat === null) continue;
      files[relative] = stat.size;
      totalBytes += stat.size;
    }
  };

  await walk(dir, "");
  staleTempFiles.sort();
  return { files, totalBytes, staleTempFiles };
}

/** 清掉中斷下載留下的暫存檔；回傳實際刪掉的路徑（相對模型目錄）。 */
export async function removeStaleTempFiles(dir: string, scan: ModelDirScan): Promise<string[]> {
  const removed: string[] = [];
  for (const relative of scan.staleTempFiles) {
    await fs
      .rm(path.join(dir, ...relative.split("/")), { force: true })
      .then(() => removed.push(relative))
      .catch(() => undefined);
  }
  return removed;
}

/** 就緒判定的結果。 */
export interface ModelReadiness {
  ready: boolean;
  /** 缺少（或大小為 0）的必要檔案。 */
  missing: string[];
  /** 目前磁碟上的檔案與大小（供進度顯示沿用已下載的部分）。 */
  files: Record<string, number>;
  totalBytes: number;
  staleTempFiles: string[];
}

/**
 * 判定模型是否已經就緒：`essentialFiles` 全部存在且大小大於 0。
 *
 * 只看「必要檔案」而不是完整清單：暫存檔＋rename 的寫入語意保證看得到的檔案都是完整的，
 * 因此少數輔助檔案（例如 `chat_template.jinja`）不存在時不必重新下載整個模型。
 */
export async function checkModelReadiness(modelDir: string, profile: ModelProfile): Promise<ModelReadiness> {
  const dir = modelRootDir(modelDir, profile);
  const scan = await scanModelDir(dir);
  const missing = profile.essentialFiles.filter((file) => (scan.files[file] ?? 0) <= 0);
  return {
    ready: missing.length === 0,
    missing: [...missing],
    files: scan.files,
    totalBytes: scan.totalBytes,
    staleTempFiles: scan.staleTempFiles,
  };
}
