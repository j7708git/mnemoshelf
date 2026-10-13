// 純函式的單元測試（Node 內建 test runner，不引入新依賴）。
// 執行：pnpm run test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bigrams, segmentWords } from "../lib/fts.mjs";
import { chunkFile, queryBucket, percentile } from "../lib/corpus.mjs";
import { rrf } from "../lib/metrics.mjs";
import { sanitize } from "../lib/paths.mjs";

test("bigrams：CJK 取相鄰二字、英數詞保留", () => {
  assert.equal(bigrams("儲存介面"), "儲存 存介 介面");
  assert.equal(bigrams("root_id 過濾"), "root_id 過濾");
  assert.equal(bigrams("AB 中"), "ab 中");
});

test("segmentWords：中文斷詞後以空白連接", () => {
  const out = segmentWords("儲存介面與向量檢索的混合排序");
  assert.ok(out.split(" ").length >= 3, `expected multiple tokens, got ${out}`);
  assert.ok(out.includes("向量"));
});

test("queryBucket：依去空白字元數分組", () => {
  assert.equal(queryBucket("儲存"), "<=2");
  assert.equal(queryBucket("向量檢索"), "3-6");
  assert.equal(queryBucket("本機多模態語意檔案總管"), ">6");
});

test("rrf：兩份清單的排名合併", () => {
  const merged = rrf([[1, 2, 3], [2, 1, 3]]);
  assert.equal(merged[0], 1);
  assert.equal(merged[1], 2);
});

test("percentile：以無條件進位取樣", () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(sorted, 50), 5);
  assert.equal(percentile(sorted, 95), 10);
});

test("chunkFile：依標題切段、超長段落再切、每塊 ≤1200 字元", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-spike-"));
  const file = path.join(dir, "sample.md");
  const longPara = "字".repeat(900);
  fs.writeFileSync(
    file,
    `# 一\n\n簡短段落\n\n# 二\n\n${longPara}\n\n${longPara}\n`,
    "utf8",
  );
  const chunks = chunkFile(file);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.text.length <= 1200));
  assert.ok(chunks.some((c) => c.title === "二"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sanitize：家目錄前綴收斂成 ~", () => {
  const out = sanitize(`path=${os.homedir()}${path.sep}workspace`);
  assert.ok(!out.includes(os.homedir()));
  assert.ok(out.startsWith("path=~"));
});
