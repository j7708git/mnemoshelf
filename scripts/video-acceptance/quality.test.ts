import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { repeatedIntervals, matchesRelevantHit } from "./relevance.mjs";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const labelsPath = path.join(base, "scripts", "video-acceptance", "queries-frozen-v1.json");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("影片凍結品質題庫", () => {
  it("保留凍結的位元組、題數及門檻", async () => {
    const bytes = await readFile(labelsPath);
    expect(digest(bytes)).toBe("846c102b582045a264388baed8ef458d5e7b1bb9278a368c73d2a564d2bece56");
    const labels = JSON.parse(bytes.toString());
    expect(labels.queries).toHaveLength(24);
    expect(labels.queries.filter((q: { track: string }) => q.track === "video")).toHaveLength(12);
    expect(labels.evaluationRoot.files).toHaveLength(10);
  });
  it("不使用共用目錄的破壞性清理", async () => {
    const runner = await readFile(path.join(base, "scripts", "video-acceptance", "run-quality.mjs"), "utf8");
    expect(runner).toContain('mkdirSync(RUN_DIR);');
    expect(runner).not.toMatch(/fs\.rm\(/);
    expect(runner).toContain('process.env.VIDEO_ACCEPTANCE_RUN !== "1"');
  });
});


describe("長片凍結語意", () => {
  it("將 V01 標註按 36 秒重複並裁切尾段", () => {
    expect(repeatedIntervals(74)).toEqual([[0, 8], [36, 44], [72, 74]]);
    const hit = { type: "chunk", relPath: "film.mp4", kind: "video", media: { track: "video", startSeconds: 36, endSeconds: 40 } };
    expect(matchesRelevantHit(hit, "film.mp4", repeatedIntervals(74))).toBe(true);
    expect(matchesRelevantHit(hit, "other.mp4", repeatedIntervals(74))).toBe(false);
    expect(matchesRelevantHit({ ...hit, media: { ...hit.media, startSeconds: 10, endSeconds: 14 } }, "film.mp4", repeatedIntervals(74))).toBe(false);
  });
});


it("安全語料未明確啟用時拒絕執行", async () => {
  const run = promisify(execFile);
  await expect(run(process.execPath, [path.join(base, "scripts", "video-acceptance", "corpus", "generate-security.mjs")], {
    cwd: base, env: { ...process.env, VIDEO_CORPUS_RUN_ID: "test-no-execution", VIDEO_SECURITY_GENERATE: "0" },
  })).rejects.toThrow();
});


it("保留歷史安全矩陣及 fixture hash", async () => {
  const bytes = await readFile(path.join(base, "scripts", "video-acceptance", "security-matrix-baseline.json"));
  expect(digest(bytes)).toBe("15cad0d4cd26d1f5f3fd4623d578e6f64740cd9babcd0d9460a0480c0e33b427");
  const matrix = JSON.parse(bytes.toString());
  expect(matrix.fixtures).toHaveLength(20);
  expect(matrix.fixtures.every((fixture: { sha256?: string }) => /^[a-f0-9]{64}$/.test(fixture.sha256 ?? ""))).toBe(true);
});
