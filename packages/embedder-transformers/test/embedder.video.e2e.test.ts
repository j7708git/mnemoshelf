/**
 * 影片幀序列的**真模型 gated 測試**（`MNEMOSHELF_E2E=1` 才跑）。
 *
 * 目的：真模型下確認 `embedVideo` 的產品契約 —— 1 幀與 4 幀都得到 **512 維、finite、L2≈1**
 * 的向量，且不走「逐張圖片向量平均」的替代路徑（同一段影片的向量與其他幀序列不同）。
 * 依專案政策：**預設不跑**、CI 不需要模型；用既有模型快取即可（不新增權重下載），
 * 以 `MNEMOSHELF_MODEL_DIR` 指向既有快取（例如研究用快取），未設定時沿用 `.tmp/models`。
 *
 * 重跑（Windows PowerShell，repo 根）：
 * ```
 * $env:MNEMOSHELF_E2E = "1"
 * $env:MNEMOSHELF_MODEL_DIR = (Resolve-Path .tmp/media-feasibility/models).Path
 * pnpm --filter @mnemoshelf/embedder-transformers exec vitest run test/embedder.video.e2e.test.ts
 * ```
 * 這段影片推論**不新增任何權重**：影片逐幀走載入文字／圖片時就已存在的 vision encoder。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
/** 模型快取：優先用研究快取環境變數，否則沿用既有 e2e 的 `.tmp/models`。 */
const MODEL_CACHE_DIR = process.env.MNEMOSHELF_MODEL_DIR ?? path.join(REPO_ROOT, ".tmp", "models");

const E2E_ENABLED = process.env.MNEMOSHELF_E2E === "1";

/** 合成影格：已凍結抽樣政策下的「最長邊 384」尺寸（16:9），確定性圖樣。 */
function frame(index: number, width = 384, height = 216): {
  pixels: Uint8Array;
  width: number;
  height: number;
  channels: 3;
  timestampSeconds: number;
} {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      pixels[at] = (x + index * 40) % 256;
      pixels[at + 1] = (y + index * 20) % 256;
      pixels[at + 2] = (index * 77) % 256;
    }
  }
  return { pixels, width, height, channels: 3, timestampSeconds: index * 4 };
}

function norm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function isFiniteVector(vector: Float32Array): boolean {
  for (const value of vector) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

describe.skipIf(!E2E_ENABLED)(
  "真模型 embedVideo e2e（需設 MNEMOSHELF_E2E=1；用既有快取、不下載新權重）",
  () => {
    it("1 幀與 4 幀輸出 512 維、所有值有限、L2 正規化，且狀態轉 ready", async () => {
      const embedder = new TransformersEmbedder({ cacheDir: MODEL_CACHE_DIR, device: "cpu" });
      expect(embedder.info.capabilities.video).toBe(true);
      expect(embedder.info.dim).toBe(512);
      expect(embedder.runtimeStatus.videoState).toBe("not-loaded");

      try {
        // 1 幀：凍結政策（每 4 秒一段、每段 1 幀）下的實際形狀。
        const single = await embedder.embedVideo({ frames: [frame(0)] });
        expect(single).toBeInstanceOf(Float32Array);
        expect(single).toHaveLength(512);
        expect(isFiniteVector(single)).toBe(true);
        expect(Math.abs(norm(single) - 1)).toBeLessThan(1e-3);
        expect(embedder.runtimeStatus).toMatchObject({ videoState: "ready", loaded: true });

        // 4 幀：保留 1–32 幀的契約容許範圍（多幀時應是同一個影片入口，不是逐張圖片平均）。
        const four = await embedder.embedVideo({ frames: [0, 1, 2, 3].map((index) => frame(index)) });
        expect(four).toHaveLength(512);
        expect(isFiniteVector(four)).toBe(true);
        expect(Math.abs(norm(four) - 1)).toBeLessThan(1e-3);

        // 內容／幀序不同 → 向量不同（不是漏掉輸入的退化實作）。
        let dot = 0;
        for (let i = 0; i < single.length; i += 1) dot += single[i]! * four[i]!;
        expect(dot).toBeLessThan(0.999);

        // 重複呼叫同一段影片是確定性的（CPU 推論）。
        const repeated = await embedder.embedVideo({ frames: [0, 1, 2, 3].map((index) => frame(index)) });
        let repeatDot = 0;
        for (let i = 0; i < four.length; i += 1) repeatDot += four[i]! * repeated[i]!;
        expect(repeatDot).toBeGreaterThanOrEqual(0.999);
      } finally {
        await embedder.dispose();
      }
    });

    it("非法幀序列在載入模型前被拒（真模型不載入）", async () => {
      const embedder = new TransformersEmbedder({ cacheDir: MODEL_CACHE_DIR, device: "cpu" });
      try {
        const frames = Array.from({ length: 33 }, (_, index) => frame(index, 8, 8));
        await expect(embedder.embedVideo({ frames })).rejects.toMatchObject({
          name: "EmbedderInputError",
          code: "invalid-video-input",
        });
        expect(embedder.runtimeStatus.loaded).toBe(false);
        expect(embedder.runtimeStatus.videoState).toBe("not-loaded");
      } finally {
        await embedder.dispose();
      }
    });
  },
);
