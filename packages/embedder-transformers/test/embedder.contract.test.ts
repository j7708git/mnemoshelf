import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEmbedderContract } from "@mnemoshelf/core/testing";
import { TransformersEmbedder } from "../src/index.js";

/** 由起始目錄往上找到含 pnpm-workspace.yaml 的 repo 根（不依賴檔案深度）。 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("找不到 repo 根（pnpm-workspace.yaml）");
    dir = parent;
  }
}

/** mnemoshelf/ 根。 */
const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
/** 模型快取固定放 mnemoshelf/.tmp（不進版控）。 */
const MODEL_CACHE_DIR = path.join(REPO_ROOT, ".tmp", "models");

const E2E_ENABLED = process.env.MNEMOSHELF_E2E === "1";

// 真實模型測試預設不跑：未設 MNEMOSHELF_E2E=1 時整個 suite 標為 skip，
// 不會下載模型、不會連網。設了才會載入模型並跑完整契約。
describe.skipIf(!E2E_ENABLED)("真實模型 e2e（需設 MNEMOSHELF_E2E=1；會下載模型）", () => {
  runEmbedderContract("transformers, e2e", () => new TransformersEmbedder({ cacheDir: MODEL_CACHE_DIR }));

  it("dispose() 後再 embed 會自動重新載入（本實作選擇自動重新載入）", async () => {
    const embedder = new TransformersEmbedder({ cacheDir: MODEL_CACHE_DIR });
    const before = await embedder.embedQuery("reload after dispose");
    await embedder.dispose();
    const after = await embedder.embedQuery("reload after dispose");
    expect(Array.from(after)).toEqual(Array.from(before));
    await embedder.dispose();
  });
});
