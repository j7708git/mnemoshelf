/**
 * 閘控 e2e（只有 `MNEMOSHELF_E2E=1` 時執行；預設 `pnpm test` 會 skip 這一檔）。
 *
 *   MNEMOSHELF_E2E=1 pnpm --filter @mnemoshelf/server run e2e
 *
 * 流程（驗收 5）：真實 embedder（模型快取在 repo 的 `.tmp/models`，不 commit）
 * → 起服務 → 加合成 root（一個 `.md`＋一張合成圖）→ preview → index
 * → `POST /search` 用**文字**找到那張圖（Top-1 為圖的 chunk）→ remember＋search 記憶。
 *
 * 不使用任何使用者檔案；所有合成資料都在 `os.tmpdir()` 下並於結束後刪除。
 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { RootPreview } from "@mnemoshelf/core";
import { createProbeImages, TransformersEmbedder } from "@mnemoshelf/embedder-transformers";
import { api, makeTempDir, removeTempDir, TEST_TOKEN } from "./helpers.js";
import { createServer, type IndexRootResponse, type MnemoshelfServer, type UnifiedSearchResult } from "../src/index.js";

const ENABLED = process.env.MNEMOSHELF_E2E === "1";

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
/** 模型快取：沿用 M0 spike 的位置（`.tmp/` 已被 .gitignore 忽略）。 */
const MODEL_DIR = path.join(REPO_ROOT, ".tmp", "models");

const tempDirs: string[] = [];
let instance: MnemoshelfServer | undefined;

afterAll(async () => {
  await instance?.close();
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

describe.skipIf(!ENABLED)("e2e（MNEMOSHELF_E2E=1 才執行）：真實 embedder 的文字→圖片檢索", () => {
  it("合成 root 的 preview／index／search（文字找到圖）與記憶讀寫", async () => {
    const rootDir = await makeTempDir("mnemoshelf-e2e-root-");
    const dataDir = await makeTempDir("mnemoshelf-e2e-data-");
    tempDirs.push(rootDir, dataDir);

    // 合成素材：一個與圖片無關的 .md，以及 M0 探測用的合成藍色方塊 PNG。
    const image = createProbeImages(256).find((entry) => entry.id === "blue_square")!;
    const query = image.descriptions[0]!; // "a solid blue square on a plain white background"
    await fs.writeFile(
      path.join(rootDir, "notes.md"),
      "# 後端筆記\n\n這份文件說明 TypeScript 建置流程與 pnpm workspace 的拓樸順序，與圖片無關。\n",
      "utf8",
    );
    await fs.writeFile(path.join(rootDir, "blue_square.png"), image.image.bytes);

    const embedder = new TransformersEmbedder({ cacheDir: MODEL_DIR });
    instance = await createServer({
      env: {},
      token: TEST_TOKEN,
      dataDir,
      port: 0,
      embedder,
      homeDir: os.homedir(),
    });
    const server = instance;

    const startedAt = Date.now();
    const created = await api(server, "POST", "/roots", {
      body: { path: rootDir, modalities: ["text", "image"] },
    });
    expect(created.status).toBe(201);
    const root = created.body as { id: number };

    const previewResponse = await api(server, "POST", `/roots/${root.id}/preview`);
    expect(previewResponse.status).toBe(200);
    const preview = previewResponse.body as RootPreview;
    expect(preview.totalFiles).toBe(2);
    expect(preview.byKind.image.count).toBe(1);
    expect(preview.byKind.text.count).toBe(1);

    const indexResponse = await api(server, "POST", `/roots/${root.id}/index`);
    expect(indexResponse.status).toBe(200);
    const indexed = indexResponse.body as IndexRootResponse;
    expect(indexed.processed).toBe(2);
    expect(indexed.skippedUnchanged).toBe(0);

    // 文字查詢 → 圖片：三種模式都量一次，回報 Top-1 與圖片命中的名次。
    const results: Record<string, UnifiedSearchResult> = {};
    for (const mode of ["keyword", "vector", "hybrid"] as const) {
      const response = await api(server, "POST", "/search", { body: { query, mode, k: 5 } });
      expect(response.status).toBe(200);
      results[mode] = response.body as UnifiedSearchResult;
    }

    const vectorTop = results.vector!.hits[0]!;
    expect(vectorTop.type).toBe("chunk");
    if (vectorTop.type !== "chunk") throw new Error("vector 模式的 Top-1 不是 chunk");
    expect(vectorTop.relPath).toBe("blue_square.png");
    expect(vectorTop.kind).toBe("image");
    expect(results.hybrid!.hits[0]!.type).toBe("chunk");

    // 記憶：寫入後用關鍵字找回來。
    const content = "e2e 記憶：文字查詢應該可以找回圖片 blue square";
    const remembered = await api(server, "POST", "/memories", { body: { content, agent: "e2e" } });
    expect(remembered.status).toBe(201);
    const memory = remembered.body as { id: number };

    const memorySearch = await api(server, "POST", "/search", { body: { query: "blue square", mode: "keyword", k: 10 } });
    const memoryHit = (memorySearch.body as UnifiedSearchResult).hits.find((hit) => hit.type === "memory");
    expect(memoryHit).toBeDefined();
    if (memoryHit?.type === "memory") {
      expect(memoryHit.id).toBe(memory.id);
      expect(memoryHit.agent).toBe("e2e");
    }

    // 量測摘要（給回報用；vitest 會顯示 console 輸出）。
    const summary = {
      embedder: { id: embedder.info.id, dim: embedder.info.dim },
      rootSetup: { path: rootDir, modalities: ["text", "image"] },
      preview: {
        totalFiles: preview.totalFiles,
        totalBytes: preview.totalBytes,
        imageFiles: preview.byKind.image.count,
        estimatedChunks: preview.estimatedChunks,
      },
      index: { durationMs: indexed.durationMs, processed: indexed.processed, total: indexed.total },
      search: Object.fromEntries(
        Object.entries(results).map(([mode, result]) => [
          mode,
          {
            hits: result.hits.length,
            top: result.hits[0] === undefined
              ? null
              : {
                  relPath: result.hits[0]!.type === "chunk" ? result.hits[0]!.relPath : null,
                  kind: result.hits[0]!.kind,
                  score: result.hits[0]!.score,
                },
            imageHit: (() => {
              const hit = result.hits.find((entry) => entry.type === "chunk" && entry.relPath === "blue_square.png");
              return hit === undefined ? null : { rank: hit.rank, score: hit.score };
            })(),
          },
        ]),
      ),
      query,
      totalMs: Date.now() - startedAt,
    };
    console.log(`[e2e] ${JSON.stringify(summary, null, 2)}`);
  });

  it("加入時不含圖片（預設）→ PATCH 開圖片 → 重新索引後文字查詢才命中圖片", async () => {
    const rootDir = await makeTempDir("mnemoshelf-e2e-patch-root-");
    const dataDir = await makeTempDir("mnemoshelf-e2e-patch-data-");
    tempDirs.push(rootDir, dataDir);

    const image = createProbeImages(256).find((entry) => entry.id === "blue_square")!;
    const query = image.descriptions[0]!; // "a solid blue square on a plain white background"
    await fs.writeFile(
      path.join(rootDir, "notes.md"),
      "# 後端筆記\n\n這份文件說明 TypeScript 建置流程與 pnpm workspace 的拓樸順序，與圖片無關。\n",
      "utf8",
    );
    await fs.writeFile(path.join(rootDir, "blue_square.png"), image.image.bytes);

    const embedder = new TransformersEmbedder({ cacheDir: MODEL_DIR });
    const server = await createServer({
      env: {},
      token: TEST_TOKEN,
      dataDir,
      port: 0,
      embedder,
      homeDir: os.homedir(),
    });
    try {
      // 1. 加入時**不帶**圖片模態（等同 UI 不勾「含圖片」）：圖片應以 modality-off 跳過。
      const created = await api(server, "POST", "/roots", { body: { path: rootDir, modalities: ["text"] } });
      expect(created.status).toBe(201);
      const root = created.body as { id: number; modalities: string[] };
      expect(root.modalities).toEqual(["text"]);

      const before = await api(server, "POST", `/roots/${root.id}/preview`);
      const previewBefore = before.body as RootPreview;
      expect(previewBefore.byKind.image.count).toBe(0);
      expect(previewBefore.skipped).toContainEqual({ relPath: "blue_square.png", reason: "modality-off" });

      const firstIndex = await api(server, "POST", `/roots/${root.id}/index`);
      expect(firstIndex.status).toBe(200);
      expect((firstIndex.body as IndexRootResponse).total).toBe(1); // 只有 notes.md

      const statusBeforePatch = await api(server, "GET", `/roots/${root.id}/index/status`);
      const runSeqBeforePatch = (statusBeforePatch.body as { runSeq: number | null }).runSeq;

      const beforeSearch = await api(server, "POST", "/search", { body: { query, mode: "vector", k: 5 } });
      expect(
        (beforeSearch.body as UnifiedSearchResult).hits.some(
          (hit) => hit.type === "chunk" && hit.relPath === "blue_square.png",
        ),
      ).toBe(false);

      // 2. PATCH 開圖片：只改設定，不自動重新索引（沒有新的一輪：state／runSeq 都不動）。
      const patched = await api(server, "PATCH", `/roots/${root.id}`, { body: { modalities: ["text", "image"] } });
      expect(patched.status).toBe(200);
      const statusAfterPatch = await api(server, "GET", `/roots/${root.id}/index/status`);
      const afterPatch = statusAfterPatch.body as { state: string; runSeq: number | null };
      expect(afterPatch.state).toBe("completed"); // 上一輪的終態，不是新的一輪
      expect(afterPatch.runSeq).toBe(runSeqBeforePatch);

      // 3. 重新索引：圖片被索引（notes.md 未變 ⇒ skippedUnchanged），且沒有失敗檔。
      const secondIndex = await api(server, "POST", `/roots/${root.id}/index`);
      expect(secondIndex.status).toBe(200);
      const indexed = secondIndex.body as IndexRootResponse;
      expect(indexed.processed).toBe(1);
      expect(indexed.skippedUnchanged).toBe(1);
      expect(indexed.failedFiles).toEqual([]);
      expect(indexed.skippedFiles).toEqual([]);

      // 4. 文字查詢命中圖片（Top-1）。
      const afterSearch = await api(server, "POST", "/search", { body: { query, mode: "vector", k: 5 } });
      const top = (afterSearch.body as UnifiedSearchResult).hits[0]!;
      expect(top.type).toBe("chunk");
      if (top.type !== "chunk") throw new Error("vector 模式的 Top-1 不是 chunk");
      expect(top.relPath).toBe("blue_square.png");
      expect(top.kind).toBe("image");

      // 5. 估時校正的對照：一張圖不再顯示不到 1 秒。
      const after = await api(server, "POST", `/roots/${root.id}/preview`);
      const previewAfter = after.body as RootPreview;
      expect(previewAfter.byKind.image.count).toBe(1);
      expect(previewAfter.estimated.imageSeconds).toBeGreaterThanOrEqual(2.4);

      console.log(
        `[e2e-patch] ${JSON.stringify(
          {
            indexedImage: { processed: indexed.processed, durationMs: indexed.durationMs },
            top: { relPath: top.relPath, kind: top.kind, score: top.score },
            estimate: previewAfter.estimated,
            query,
          },
          null,
          2,
        )}`,
      );
    } finally {
      await server.close();
    }
  });
});
