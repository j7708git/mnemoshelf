/**
 * 圖片輸入錯誤（`EmbedderInputError`）的遮罩驗證（mock 取代 `@huggingface/transformers`）。
 *
 * 解碼失敗的底層錯誤常帶本機絕對路徑（例如 sharp 的 `… open '<家目錄>/…/x.heic'`）。
 * 這一類錯誤會往上傳到 core 與 REST／日誌，因此**訊息與 `cause` 都必須是已遮罩的摘要**：
 * 只要原始錯誤留在 `cause`，`console.error(error)`／`util.inspect(error)` 就會把
 * `[cause]` 連同家目錄一起印出來（遮罩等於白做）。
 *
 * 測試用的「家目錄」是執行環境的 `os.homedir()`（不寫死任何使用者路徑）；
 * 程式碼中的遮罩機制就是以此為基準（`summarizeFailure`）。
 */
import { homedir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedderInputError, EmptyImageInputError, TransformersEmbedder } from "../src/index.js";

const state = vi.hoisted(() => ({ decodeError: null as Error | null }));

vi.mock("@huggingface/transformers", () => {
  const processor = Object.assign(async () => ({ batch: 1 }), { image_processor: { max_soft_tokens: 0 } });
  return {
    env: { cacheDir: "" },
    AutoConfig: { from_pretrained: async () => ({ audio_config: {} }) },
    AutoProcessor: { from_pretrained: async () => processor },
    AutoModel: {
      from_pretrained: async () => Object.assign(async () => ({ sentence_embedding: undefined }), {
        dispose: async () => undefined,
      }),
    },
    load_image: async () => {
      if (state.decodeError !== null) throw state.decodeError;
      return {};
    },
  };
});

const HOME = homedir();
const LEAKY_PATH = path.join(HOME, "Photos", "sample.heic");

afterEach(() => {
  state.decodeError = null;
});

async function embedBadImage(): Promise<unknown> {
  state.decodeError = new Error(`Input buffer contains unsupported image format: open '${LEAKY_PATH}'`);
  const embedder = new TransformersEmbedder({ platform: "linux", cacheDir: "unused" });
  return await embedder.embedImage({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/heic" }).catch((error) => error);
}

describe("EmbedderInputError 的去識別化", () => {
  it("訊息遮罩家目錄，且帶穩定錯誤碼", async () => {
    const error = await embedBadImage();
    expect(error).toBeInstanceOf(EmbedderInputError);
    const inputError = error as EmbedderInputError;
    expect(inputError.code).toBe("undecodable");
    expect(inputError.message).not.toContain(HOME);
    expect(inputError.message).toContain("~");
  });

  it("cause 是已遮罩的摘要，不含家目錄（連帶保護 console.error／util.inspect）", async () => {
    const error = await embedBadImage();
    const cause = (error as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).not.toContain(HOME);
    expect((cause as Error).message).toContain("~");

    // 真正的洩漏途徑：整個錯誤物件被原樣輸出（含 `[cause]` 與 stack）。
    // 判準是「底層錯誤帶的實際檔案路徑」不得出現（遮罩後是 `~/Photos/sample.heic`）。
    // 註：stack 的格線本身會出現本 repo 的原始碼路徑（測試環境的必然結果），
    // 那不是這個錯誤攜帶的資料，因此不列入判準。
    const dumped = `${inspect(error)}\n${String((error as Error).stack)}`;
    expect(dumped).not.toContain(LEAKY_PATH);
    expect(dumped).not.toContain(path.dirname(LEAKY_PATH));
    expect(dumped).toContain("~/Photos/sample.heic");
  });

  it("已是 EmbedderInputError 者原樣拋出，不重複包裝", async () => {
    const original = new EmbedderInputError("解不開（測試）");
    state.decodeError = original;
    const embedder = new TransformersEmbedder({ platform: "linux", cacheDir: "unused" });
    const error = await embedder
      .embedImage({ bytes: Uint8Array.from([1]), mimeType: "image/png" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBe(original);
  });

  it("零位元組圖片仍是 EmptyImageInputError（不受遮罩改動影響）", async () => {
    const embedder = new TransformersEmbedder({ platform: "linux", cacheDir: "unused" });
    const error = await embedder.embedImage({ bytes: new Uint8Array(0) }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EmptyImageInputError);
  });
});
