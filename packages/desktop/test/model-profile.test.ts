import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_PROFILE, checkModelReadiness, isStaleTempFile, modelRootDir, scanModelDir } from "../src/model-profile.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-model-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** 在模型目錄裡寫檔（自動建上層目錄）。 */
async function write(relative: string, bytes: number): Promise<void> {
  const full = path.join(modelRootDir(dir, MODEL_PROFILE), ...relative.split("/"));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.alloc(bytes, 7));
}

describe("modelRootDir", () => {
  it("模型落在 <modelDir>/<模型 id 的每一段>（與 transformers.js 的快取 key 一致）", () => {
    const expected = path.join(path.resolve(dir), ...MODEL_PROFILE.modelId.split("/"));
    expect(modelRootDir(dir, MODEL_PROFILE)).toBe(expected);
  });
});

describe("isStaleTempFile", () => {
  it("認得 FileCache 的 tmp 命名", () => {
    expect(isStaleTempFile("model_q4.onnx_data.tmp.1234.abc")).toBe(true);
    expect(isStaleTempFile("model_q4.onnx_data")).toBe(false);
    expect(isStaleTempFile("config.json")).toBe(false);
  });
});

describe("checkModelReadiness", () => {
  it("全部必要檔案都在（且非空）才算就緒", async () => {
    const empty = await checkModelReadiness(dir, MODEL_PROFILE);
    expect(empty.ready).toBe(false);
    expect(empty.missing).toContain("onnx/model_q4.onnx_data");

    for (const file of MODEL_PROFILE.essentialFiles) await write(file, 16);
    const ready = await checkModelReadiness(dir, MODEL_PROFILE);
    expect(ready.ready).toBe(true);
    expect(ready.missing).toEqual([]);
    expect(ready.totalBytes).toBe(MODEL_PROFILE.essentialFiles.length * 16);
  });

  it("大小為 0 的檔案視為缺少（下載中斷不會留下半殘檔，但空檔仍不可用）", async () => {
    for (const file of MODEL_PROFILE.essentialFiles) await write(file, 16);
    await write("tokenizer.json", 0);
    const result = await checkModelReadiness(dir, MODEL_PROFILE);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(["tokenizer.json"]);
  });

  it("只缺少輔助檔案時仍視為就緒（不必重抓整個模型）", async () => {
    for (const file of MODEL_PROFILE.essentialFiles) await write(file, 16);
    await write("chat_template.jinja", 10);
    const result = await checkModelReadiness(dir, MODEL_PROFILE);
    expect(result.ready).toBe(true);
  });
});

describe("scanModelDir", () => {
  it("列出檔案大小，並把中斷下載的暫存檔另外標記", async () => {
    await write("config.json", 8);
    await write(path.join("onnx", "model_q4.onnx_data"), 128);
    await write("model_q4.onnx_data.tmp.999.tag", 4096);

    const scan = await scanModelDir(modelRootDir(dir, MODEL_PROFILE));
    expect(scan.files).toEqual({ "config.json": 8, "onnx/model_q4.onnx_data": 128 });
    expect(scan.totalBytes).toBe(136);
    expect(scan.staleTempFiles).toEqual(["model_q4.onnx_data.tmp.999.tag"]);
  });

  it("目錄不存在時回空的結果（不是錯誤）", async () => {
    const scan = await scanModelDir(path.join(dir, "missing"));
    expect(scan).toEqual({ files: {}, totalBytes: 0, staleTempFiles: [] });
  });
});
