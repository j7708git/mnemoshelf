/**
 * 精煉記憶優先分層召回評測（Issue #22 P2；`TIERED_EVAL=1` 才執行）。
 *
 * 合成情境：每個專案各有 1 筆「目標」精煉記憶、3 筆干擾精煉記憶，以及多筆長篇雜訊 `raw-turn`
 * （cosine 常高於目標）。比較四種注入策略的「精煉 Top-4 命中率」、平均注入字元與 10 步回合累積字元：
 *
 * - `flat`：`preferRefined: false`（原本的純 cosine 排序）；
 * - `tiered`：`preferRefined: true`（精煉記憶優先分層）；
 * - `refined-only`：專案設為 `refined-only` 且 `channel: "auto"`；
 * - `off`：專案設為 `off` 且 `channel: "auto"`（不檢索、不注入）。
 *
 * 全程使用可控 embedder 與合成資料（不載入任何真實模型、不讀取使用者檔案）。
 * 執行：`TIERED_EVAL=1 pnpm --filter @mnemoshelf/server exec vitest run -c eval/raw-memory/vitest.config.ts eval/raw-memory/tiered-recall.test.ts`
 */
import { describe, expect, it } from "vitest";
import type {
  DocumentInput,
  EmbedDocumentsOptions,
  Embedder,
  EmbedderInfo,
  ImageInput,
  MemoryAutoInjectSettings,
  ProbeResult,
} from "@mnemoshelf/core";
import type { MemoryRecallResponseBody } from "../../src/memory-search.js";
import { api, startTestServer } from "../../test/helpers.js";

const QUERY_COUNT = 40;
const RAW_PER_PROJECT = 12;
const DISTRACTOR_REFINED = 3;
const TOP_K = 4;
const MIN_SCORE = 0.65;
const TURNS = 10;

/** 可重現的偽隨機數（mulberry32）。 */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 文件內含 `[[cos:x]]` 時，向量與查詢 [1,0] 的 cosine 即為 x。 */
class EvalEmbedder implements Embedder {
  readonly info: EmbedderInfo = {
    id: "tiered-eval-embedder@test",
    dim: 2,
    capabilities: { text: true, image: true, audio: false, video: false },
  };
  queryCalls = 0;

  async embedQuery(): Promise<Float32Array> {
    this.queryCalls += 1;
    return new Float32Array([1, 0]);
  }

  async embedDocument(text: string): Promise<Float32Array> {
    const match = /\[\[cos:([0-9.]+)\]\]/.exec(text);
    const cos = match === null ? 0.1 : Number(match[1]);
    return new Float32Array([cos, Math.sqrt(1 - cos * cos)]);
  }

  async embedDocuments(inputs: readonly DocumentInput[], _opts?: EmbedDocumentsOptions): Promise<Float32Array[]> {
    return await Promise.all(inputs.map((input) => this.embedDocument(input.text)));
  }

  async embedImage(_image: ImageInput): Promise<Float32Array> {
    return new Float32Array([1, 0]);
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, message: "評測用 embedder" };
  }

  async dispose(): Promise<void> {
    // 無資源。
  }
}

interface Case {
  project: string;
  targetId: number;
}

interface Strategy {
  name: string;
  hitRate: number;
  avgChars: number;
  cumulativeChars: number;
}

const NOISE = "這是一段很長的原始對話雜訊，包含大量與當前問題無關的工具輸出、除錯訊息與閒聊內容，用來模擬原文片段擠占注入預算。";

describe.skipIf(process.env.TIERED_EVAL !== "1")("精煉記憶優先分層召回評測", () => {
  it("對比 flat／tiered／refined-only／off 的命中率與注入字元", async () => {
    const embedder = new EvalEmbedder();
    const server = await startTestServer({ embedder });
    try {
      const instance = server.instance;
      const random = prng(22);
      const between = (low: number, high: number) => (low + (high - low) * random()).toFixed(3);
      const cases: Case[] = [];
      let total = 0;
      let turn = 0;

      for (let index = 0; index < QUERY_COUNT; index += 1) {
        const project = `tier-eval-${index}`;
        const add = async (content: string): Promise<number> => {
          const response = await api(instance, "POST", "/memories", {
            body: { agent: "tier-eval", scope: "project", project, content },
          });
          expect(response.status).toBe(201);
          total += 1;
          return (response.body as { id: number }).id;
        };
        const targetId = await add(`目標精煉結論 ${index}：採用方案 B 並保留相容層。[[cos:${between(0.66, 0.78)}]]`);
        for (let d = 0; d < DISTRACTOR_REFINED; d += 1) await add(`干擾精煉記憶 ${index}-${d}。[[cos:${between(0.3, 0.6)}]]`);
        for (let r = 0; r < RAW_PER_PROJECT; r += 1) {
          turn += 1;
          const content = `${NOISE.slice(0, 120)} [[cos:${between(0.6, 0.88)}]] ${NOISE.slice(0, 120)}`;
          const response = await api(instance, "POST", "/memory-sources", {
            body: {
              agent: "tier-eval",
              scope: "project",
              project,
              sourceSession: `eval-session-${index}`,
              sourceTurn: `turn-${turn}`,
              messages: [{ sourceMessage: `m-${turn}`, role: "user", content, occurredAt: null }],
            },
          });
          expect(response.status).toBe(201);
          // 評測假設每則原文只有單一 chunk，否則 cosine 標記會失真。
          expect((response.body as { memoryIds: number[] }).memoryIds).toHaveLength(1);
          total += 1;
        }
        cases.push({ project, targetId });
      }

      const deadline = Date.now() + 120_000;
      for (;;) {
        const diagnostics = (await api(instance, "GET", "/diagnostics")).body as { memories?: { ready?: number } };
        if ((diagnostics.memories?.ready ?? 0) >= total) break;
        if (Date.now() > deadline) throw new Error("等待評測記憶就緒逾時");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const setAll = async (mode: "refined-only" | "off") => {
        const current = (await api(instance, "GET", "/memory-auto-inject")).body as MemoryAutoInjectSettings;
        const projects = Object.fromEntries(cases.map((item) => [item.project, mode]));
        const response = await api(instance, "PATCH", "/memory-auto-inject", {
          body: { expectedRevision: current.revision, projects },
        });
        expect(response.status).toBe(200);
      };

      const measure = async (name: string, extra: Record<string, unknown>): Promise<Strategy> => {
        let hits = 0;
        let chars = 0;
        for (const item of cases) {
          const response = await api(instance, "POST", "/memories/search", {
            body: { query: "我們採用哪個方案？", project: item.project, k: TOP_K, minScore: MIN_SCORE, ...extra },
          });
          expect(response.status).toBe(200);
          const body = response.body as MemoryRecallResponseBody;
          if (body.hits.some((hit) => hit.id === item.targetId)) hits += 1;
          chars += body.hits.reduce((sum, hit) => sum + Array.from(hit.content).length, 0);
        }
        const avgChars = chars / cases.length;
        return { name, hitRate: hits / cases.length, avgChars, cumulativeChars: avgChars * TURNS };
      };

      const flat = await measure("flat (preferRefined=false)", { preferRefined: false, channel: "manual" });
      const tiered = await measure("tiered (preferRefined=true)", { preferRefined: true, channel: "manual" });
      await setAll("refined-only");
      const refinedOnly = await measure("refined-only (auto)", { channel: "auto" });
      embedder.queryCalls = 0;
      await setAll("off");
      const off = await measure("off (auto)", { channel: "auto" });
      expect(embedder.queryCalls).toBe(0);

      const rows = [flat, tiered, refinedOnly, off];
      console.log(
        [
          `| 策略 | 精煉 Top-${TOP_K} 命中率 | 平均注入字元 | ${TURNS} 步累積字元 |`,
          "| --- | ---: | ---: | ---: |",
          ...rows.map((row) => `| ${row.name} | ${(row.hitRate * 100).toFixed(1)}% | ${row.avgChars.toFixed(0)} | ${row.cumulativeChars.toFixed(0)} |`),
        ].join("\n"),
      );

      expect(tiered.hitRate).toBeGreaterThanOrEqual(flat.hitRate);
      expect(refinedOnly.hitRate).toBeGreaterThanOrEqual(tiered.hitRate);
      expect(refinedOnly.avgChars).toBeLessThanOrEqual(tiered.avgChars);
      expect(off.hitRate).toBe(0);
      expect(off.avgChars).toBe(0);
      expect(off.cumulativeChars).toBe(0);
    } finally {
      await server.close();
    }
  });
});
