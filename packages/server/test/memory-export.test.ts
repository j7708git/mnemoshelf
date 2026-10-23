/**
 * 記憶備份（NDJSON 匯出／匯入）的 REST 與純函式測試。
 *
 * 全部使用合成資料與暫存資料目錄，不讀取任何使用者檔案。重點：
 * - 匯出：只含未刪除、createdAt 由舊到新、讀取遮罩視圖、結尾換行、附件標頭；
 * - 匯入：整批先驗證（任一非法 → 400 且完全不寫）、先遮罩再存、精確去重、保留 pinned、
 *   不保留 id／createdAt／supersedes、dry-run 不寫入、空檔全 0、超過 32 MiB → 413；
 * - 純函式：序列化、解析（BOM／CRLF／空行）、dry-run 估算、旗標嚴格值域。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Memory } from "@mnemoshelf/core";
import {
  countImportDuplicates,
  MAX_MEMORY_IMPORT_BYTES,
  MEMORY_EXPORT_SCHEMA_VERSION,
  memoryExportFilename,
  parseDryRunParam,
  planMemoryImport,
  serializeMemoriesExport,
  type ListMemoriesResponse,
  type MemoryImportResponse,
  type MnemoshelfServer,
} from "../src/index.js";
import { api, rawHttpRequest, removeTempDir, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";

/** 以片段拼接組出「看起來像憑證」的合成樣本（原始碼不出現連續的憑證字面值）。 */
function fake(...parts: string[]): string {
  return parts.join("");
}

const GITHUB_STYLE_TOKEN = fake("gh", "p_", "0123456789abcdefghijklmn");

/** 取得錯誤回應的 `error.name`。 */
function errorName(body: unknown): unknown {
  return (body as { error?: { name?: unknown } } | null)?.error?.name;
}

/** 依序建立記憶（走 REST 寫入路徑）。 */
async function postMemory(
  instance: MnemoshelfServer,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return await api(instance, "POST", "/memories", { body });
}

/** 列出記憶（REST；失敗即測試失敗）。 */
async function listMemoryRows(instance: MnemoshelfServer): Promise<Memory[]> {
  const response = await api(instance, "GET", "/memories");
  expect(response.status).toBe(200);
  return (response.body as ListMemoriesResponse).memories;
}

/** 下載匯出檔（原始 bytes 解碼成文字，才能驗證結尾換行與位元組格式）。 */
async function exportMemories(instance: MnemoshelfServer): Promise<{
  status: number;
  text: string;
  contentType: string | null;
  contentDisposition: string | null;
}> {
  const response = await fetch(`${instance.url}/memories/export`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type"),
    contentDisposition: response.headers.get("content-disposition"),
  };
}

/** 以原始 NDJSON 呼叫匯入（不經 JSON 包裝）；回傳解析後的 JSON 與狀態。 */
async function importNdjson(
  instance: MnemoshelfServer,
  body: string | Uint8Array,
  query = "",
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`${instance.url}/memories/import${query}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      "content-type": "application/x-ndjson",
    },
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() === "" ? null : (JSON.parse(text) as unknown),
    headers: response.headers,
  };
}

/** 把（已序列化的）JSON 物件陣列接成 NDJSON。 */
function ndjson(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/** 合法匯入列（只覆寫關心的欄位）。 */
function importRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
    content: "匯入的合成記憶",
    kind: "fact",
    scope: "global",
    project: null,
    agent: "agent-c3",
    pinned: false,
    ...overrides,
  };
}

/** 匯出檔的每一行解析成物件（含行號）；最後一行的空字串不算一列。 */
function parseExportLines(text: string): { line: number; record: Record<string, unknown> }[] {
  expect(text.endsWith("\n")).toBe(true);
  const lines = text.split("\n");
  expect(lines.at(-1)).toBe("");
  return lines.slice(0, -1).map((line, index) => ({
    line: index + 1,
    record: JSON.parse(line) as Record<string, unknown>,
  }));
}

let server: TestServer | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = undefined;
  while (dirs.length > 0) await removeTempDir(dirs.pop()!);
});

describe("記憶匯出：GET /memories/export", () => {
  it("只匯未刪除、createdAt 由舊到新、附件標頭與 NDJSON 欄位完整", async () => {
    server = await startTestServer();
    const instance = server.instance;

    const keptFirst = await postMemory(instance, { content: "第一筆保留記憶", agent: "agent-c3" });
    const forgotten = await postMemory(instance, { content: "這一筆會被軟刪除", agent: "agent-c3" });
    const replaced = await postMemory(instance, { content: "這一筆會被取代", agent: "agent-c3" });
    const keptSecond = await postMemory(instance, {
      content: "第二筆保留記憶",
      agent: "agent-c3",
      scope: "project",
      project: "proj-export",
    });
    const replacement = await postMemory(instance, {
      content: "取代後的新版本",
      agent: "agent-c3",
      supersedes: (replaced.body as { id: number }).id,
    });

    expect(forgotten.status).toBe(201);
    expect(replacement.status).toBe(201);
    await api(instance, "DELETE", `/memories/${(forgotten.body as { id: number }).id}`);

    const exported = await exportMemories(instance);
    expect(exported.status).toBe(200);
    expect(exported.contentType).toBe("application/x-ndjson; charset=utf-8");
    expect(exported.contentDisposition).toMatch(/^attachment; filename="memories-\d{8}\.ndjson"$/);

    const lines = parseExportLines(exported.text);
    expect(lines.map(({ record }) => record.id)).toEqual([
      (keptFirst.body as { id: number }).id,
      (keptSecond.body as { id: number }).id,
      (replacement.body as { id: number }).id,
    ]);
    // 已刪除與被取代者不匯出。
    expect(exported.text).not.toContain("這一筆會被軟刪除");
    expect(exported.text).not.toContain("這一筆會被取代");

    const first = lines[0]!.record;
    expect(first).toEqual({
      schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
      id: (keptFirst.body as { id: number }).id,
      content: "第一筆保留記憶",
      kind: "fact",
      scope: "global",
      project: null,
      agent: "agent-c3",
      sourceSession: null,
      sourceMessage: null,
      pinned: false,
      createdAt: (keptFirst.body as { createdAt: string }).createdAt,
      supersedes: null,
    });
    // 欄位順序固定（人眼看 diff 用；JSON 解析本來就不保證順序，這裡額外釘住序列化器）。
    expect(Object.keys(first)).toEqual([
      "schemaVersion",
      "id",
      "content",
      "kind",
      "scope",
      "project",
      "agent",
      "sourceSession",
      "sourceMessage",
      "pinned",
      "createdAt",
      "supersedes",
    ]);

    // createdAt 由舊到新。
    const times = lines.map(({ record }) => Date.parse(String(record.createdAt)));
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]!).toBeGreaterThanOrEqual(times[index - 1]!);
    }
  });

  it("空資料庫匯出成 0 bytes 的空檔（不是只有換行）", async () => {
    server = await startTestServer();
    const exported = await exportMemories(server.instance);
    expect(exported.status).toBe(200);
    expect(exported.text).toBe("");
    expect(exported.contentType).toBe("application/x-ndjson; charset=utf-8");
    expect(exported.contentDisposition).toMatch(/^attachment; filename="memories-\d{8}\.ndjson"$/);
  });

  it("讀取遮罩：資料庫裡的舊資料即使未遮罩，匯出檔也不會出現憑證原文", async () => {
    server = await startTestServer();
    const instance = server.instance;
    // 直接寫 store，模擬 C2 之前就存在的未遮罩舊資料（繞過 REST 的寫入遮罩）。
    const legacy = await instance.store.addMemory({
      content: `部署金鑰 ${GITHUB_STYLE_TOKEN} 放在舊資料`,
      kind: "pitfall",
      scope: "global",
      project: null,
      agent: "agent-legacy",
      supersedes: null,
    });
    // 同一批舊資料的 agent／project 也可能含 token-like 機密（寫入路徑早已會拒絕，這裡模擬更舊的資料）。
    const legacyMetadata = await instance.store.addMemory({
      content: "舊資料的 agent／project 未遮罩",
      kind: "fact",
      scope: "project",
      project: `proj ${GITHUB_STYLE_TOKEN}`,
      agent: `agent ${GITHUB_STYLE_TOKEN}`,
      supersedes: null,
    });
    // 來源欄位同理（REST 會拒絕，但直接寫 DB 的資料仍可能在讀取路徑被遮罩）。
    const legacySource = await instance.store.addMemory({
      content: "舊資料的來源欄位未遮罩",
      kind: "fact",
      scope: "global",
      project: null,
      agent: "agent-legacy",
      supersedes: null,
      sourceSession: `session ${GITHUB_STYLE_TOKEN}`,
      sourceMessage: `message ${GITHUB_STYLE_TOKEN}`,
    });

    const exported = await exportMemories(instance);
    expect(exported.status).toBe(200);
    expect(exported.text).not.toContain(GITHUB_STYLE_TOKEN);
    expect(exported.text).toContain("[REDACTED:");
    const rows = parseExportLines(exported.text);
    const maskedRow = rows.find(({ record }) => record.id === legacy.id)?.record;
    expect(maskedRow?.content).not.toContain(GITHUB_STYLE_TOKEN);
    const metadataRow = rows.find(({ record }) => record.id === legacyMetadata.id)?.record;
    expect(metadataRow?.agent).not.toContain(GITHUB_STYLE_TOKEN);
    expect(metadataRow?.project).not.toContain(GITHUB_STYLE_TOKEN);
    const sourceRow = rows.find(({ record }) => record.id === legacySource.id)?.record;
    expect(sourceRow?.sourceSession).not.toContain(GITHUB_STYLE_TOKEN);
    expect(sourceRow?.sourceMessage).not.toContain(GITHUB_STYLE_TOKEN);
  });

  it("來源欄位：帶 sourceSession／sourceMessage 的記憶匯出時一併帶出（schemaVersion 維持 1）", async () => {
    server = await startTestServer();
    const instance = server.instance;

    const created = await postMemory(instance, {
      content: "自動寫入的合成記憶",
      agent: "opencode-plugin@0.1.0",
      // 前後空白由 REST 正規化後儲存。
      sourceSession: "  ses_synthetic_0001  ",
      sourceMessage: "msg_synthetic_0001",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      sourceSession: "ses_synthetic_0001",
      sourceMessage: "msg_synthetic_0001",
    });

    const exported = await exportMemories(instance);
    expect(exported.status).toBe(200);
    const record = parseExportLines(exported.text)[0]!.record;
    expect(record.schemaVersion).toBe(MEMORY_EXPORT_SCHEMA_VERSION);
    expect(record).toMatchObject({
      sourceSession: "ses_synthetic_0001",
      sourceMessage: "msg_synthetic_0001",
    });
  });
});

describe("記憶匯入：POST /memories/import", () => {
  it("round-trip：匯出→硬刪除→匯入後內容／範圍／kind／pinned 一致（新 id、新時間、無 supersedes）", async () => {
    server = await startTestServer();
    const instance = server.instance;

    const inputs: { body: Record<string, unknown>; pinned?: boolean }[] = [
      {
        body: { content: "中文記憶：部署流程要先跑遷移", kind: "fact", agent: "agent-c3", scope: "global" },
      },
      {
        body: {
          content: "English memory: prefer the smallest change",
          kind: "decision",
          agent: "agent-c3",
          scope: "project",
          project: "proj-roundtrip",
          sourceSession: "session-roundtrip",
          sourceMessage: "message-roundtrip",
        },
        pinned: true,
      },
      {
        body: {
          content: "踩坑：Windows 路徑要用 node:path",
          kind: "pitfall",
          agent: "agent-c3",
          scope: "agent",
        },
      },
      {
        body: {
          content: "偏好：回覆用繁體中文",
          kind: "preference",
          agent: "agent-c3",
          scope: "project",
          project: "proj-roundtrip",
        },
        pinned: true,
      },
    ];

    const originals: { id: number; createdAt: string; pinned: boolean; tuple: unknown }[] = [];
    for (const input of inputs) {
      const response = await postMemory(instance, input.body);
      expect(response.status).toBe(201);
      const created = response.body as Memory;
      if (input.pinned === true) {
        const pinned = await api(instance, "POST", `/memories/${created.id}/pin`, { body: { pinned: true } });
        expect(pinned.status).toBe(200);
      }
      originals.push({
        id: created.id,
        createdAt: created.createdAt,
        pinned: input.pinned === true,
        tuple: {
          content: created.content,
          kind: created.kind,
          scope: created.scope,
          project: created.project,
          agent: created.agent,
          sourceSession: created.sourceSession,
          sourceMessage: created.sourceMessage,
        },
      });
    }

    const exported = await exportMemories(instance);
    expect(exported.status).toBe(200);
    expect(parseExportLines(exported.text)).toHaveLength(originals.length);
    expect(exported.text.match(/"pinned":true/g)).toHaveLength(2);

    // 硬刪除全部（清空），再從備份還原。
    for (const original of originals) {
      const removed = await api(instance, "DELETE", `/memories/${original.id}?hard=true`);
      expect(removed.status).toBe(200);
    }
    expect(await listMemoryRows(instance)).toEqual([]);

    const imported = await importNdjson(instance, exported.text);
    expect(imported.status).toBe(200);
    const result = imported.body as MemoryImportResponse;
    expect(result).toEqual({
      dryRun: false,
      total: originals.length,
      valid: originals.length,
      invalid: [],
      duplicates: 0,
      redacted: 0,
      created: originals.length,
      wouldCreate: 0,
    });

    const restored = await listMemoryRows(instance);
    expect(restored).toHaveLength(originals.length);
    const byContent = new Map(restored.map((memory) => [memory.content, memory]));
    for (const original of originals) {
      const tuple = original.tuple as {
        content: string;
        kind: string;
        scope: string;
        project: string | null;
        agent: string;
        sourceSession: string | null;
        sourceMessage: string | null;
      };
      const memory = byContent.get(tuple.content);
      expect(memory, tuple.content).toBeDefined();
      expect({
        content: memory!.content,
        kind: memory!.kind,
        scope: memory!.scope,
        project: memory!.project,
        agent: memory!.agent,
        sourceSession: memory!.sourceSession,
        sourceMessage: memory!.sourceMessage,
      }).toEqual(tuple);
      expect(memory!.pinned).toBe(original.pinned);
      // 不保留 id／createdAt／supersedes。
      expect(memory!.id).not.toBe(original.id);
      expect(memory!.createdAt).not.toBe(original.createdAt);
      expect(memory!.supersedes).toBeNull();
    }
    // 新 id 全部不同於舊 id。
    expect(restored.every((memory) => !originals.some((original) => original.id === memory.id))).toBe(true);
    // 兩筆 pinned 真的有保留。
    expect(restored.filter((memory) => memory.pinned)).toHaveLength(2);
  });

  it("來源欄位：舊格式（無欄位）補 null、帶欄位的新備份保留；空白／超長／token-like → 整批 400", async () => {
    server = await startTestServer();
    const instance = server.instance;

    // 舊格式：完全沒有 sourceSession／sourceMessage 這兩個鍵（模擬 D4a 之前的備份）。
    const legacyRecord = {
      schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
      content: "舊格式備份的合成記憶",
      kind: "fact",
      scope: "global",
      project: null,
      agent: "agent-legacy",
      pinned: false,
    };
    const imported = await importNdjson(
      instance,
      ndjson([
        legacyRecord,
        importRecord({
          content: "新格式備份的合成記憶",
          agent: "opencode-plugin@0.1.0",
          sourceSession: "ses_synthetic_0002",
          sourceMessage: "msg_synthetic_0002",
        }),
      ]),
    );
    expect(imported.status).toBe(200);
    expect((imported.body as MemoryImportResponse).created).toBe(2);

    const rows = await listMemoryRows(instance);
    expect(rows.find((memory) => memory.content === legacyRecord.content)).toMatchObject({
      sourceSession: null,
      sourceMessage: null,
    });
    expect(rows.find((memory) => memory.content === "新格式備份的合成記憶")).toMatchObject({
      sourceSession: "ses_synthetic_0002",
      sourceMessage: "msg_synthetic_0002",
    });

    // 不合法：空白、超長、token-like → 整批 400（完全不寫）。
    const baseline = await listMemoryRows(instance);
    const rejected = await importNdjson(
      instance,
      ndjson([
        importRecord({ content: "這一筆合法但整批不能寫", agent: "agent-legacy" }),
        importRecord({ content: "空白來源", sourceSession: "   " }),
        importRecord({ content: "超長來源", sourceSession: "x".repeat(201) }),
        importRecord({ content: "來源帶憑證", sourceMessage: `msg ${GITHUB_STYLE_TOKEN}` }),
      ]),
    );
    expect(rejected.status).toBe(400);
    expect(errorName(rejected.body)).toBe("ValidationError");
    expect((rejected.body as MemoryImportResponse).invalid.map((item) => item.line)).toEqual([2, 3, 4]);
    expect(await listMemoryRows(instance)).toEqual(baseline);
  });

  it("匯入遮罩：內容先遮罩才寫入；agent／project token-like → 整批 400 不寫", async () => {
    server = await startTestServer();
    const instance = server.instance;

    const imported = await importNdjson(
      instance,
      ndjson([importRecord({ content: `寫入前要遮罩 ${GITHUB_STYLE_TOKEN}`, kind: "pitfall" })]),
    );
    expect(imported.status).toBe(200);
    expect((imported.body as MemoryImportResponse).redacted).toBe(1);
    expect((imported.body as MemoryImportResponse).created).toBe(1);

    const listed = await listMemoryRows(instance);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.content).not.toContain(GITHUB_STYLE_TOKEN);
    expect(listed[0]?.content).toContain("[REDACTED:");
    // 直接讀 store 的原文（未遮罩視圖）也證實沒有把憑證原文寫進 DB。
    const stored = await instance.store.listMemoriesForExport();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).not.toContain(GITHUB_STYLE_TOKEN);

    const before = await listMemoryRows(instance);
    const rejected = await importNdjson(
      instance,
      ndjson([
        importRecord({ content: "合法的內容" }),
        importRecord({ content: "agent 帶憑證", agent: `agent ${GITHUB_STYLE_TOKEN}` }),
        importRecord({ content: "project 帶憑證", scope: "project", project: `proj ${GITHUB_STYLE_TOKEN}` }),
      ]),
    );
    expect(rejected.status).toBe(400);
    expect(errorName(rejected.body)).toBe("ValidationError");
    const body = rejected.body as MemoryImportResponse;
    expect(body.valid).toBe(1);
    expect(body.invalid.map((item) => item.line)).toEqual([2, 3]);
    expect(await listMemoryRows(instance)).toEqual(before);
  });

  it("dry-run 不寫入、先驗證；正式匯入才建立（含 dryRun 旗標嚴格值域）", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const existing = await postMemory(instance, { content: "既有記憶", agent: "agent-c3", scope: "global" });
    expect(existing.status).toBe(201);

    const text = ndjson([
      importRecord({ content: "既有記憶", agent: "agent-c3" }),
      importRecord({ content: "批次新增一", agent: "agent-c3" }),
      importRecord({ content: "批次新增二", agent: "agent-c3", pinned: true }),
    ]);

    const dryRun = await importNdjson(instance, text, "?dryRun=1");
    expect(dryRun.status).toBe(200);
    expect(dryRun.body).toEqual({
      dryRun: true,
      total: 3,
      valid: 3,
      invalid: [],
      duplicates: 1,
      redacted: 0,
      created: 0,
      wouldCreate: 2,
    });
    expect(await listMemoryRows(instance)).toHaveLength(1);

    // `true` 也是合法值；結果一致。
    const dryRunTrue = await importNdjson(instance, text, "?dryRun=true");
    expect(dryRunTrue.status).toBe(200);
    expect((dryRunTrue.body as MemoryImportResponse).wouldCreate).toBe(2);

    for (const value of ["0", "false", "yes", ""]) {
      const rejected = await importNdjson(instance, text, `?dryRun=${value}`);
      expect(rejected.status, value).toBe(400);
      expect(errorName(rejected.body)).toBe("ValidationError");
    }
    expect(await listMemoryRows(instance)).toHaveLength(1);

    const real = await importNdjson(instance, text);
    expect(real.status).toBe(200);
    expect(real.body).toEqual({
      dryRun: false,
      total: 3,
      valid: 3,
      invalid: [],
      duplicates: 1,
      redacted: 0,
      created: 2,
      wouldCreate: 0,
    });
    const after = await listMemoryRows(instance);
    expect(after).toHaveLength(3);
    expect(after.filter((memory) => memory.pinned)).toHaveLength(1);
  });

  it("非法行整批 400（含行號與原因），完全不寫入", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const baseline = await postMemory(instance, { content: "基準記憶", agent: "agent-c3" });
    expect(baseline.status).toBe(201);

    const lines = [
      JSON.stringify(importRecord({ content: "這筆合法但整批不能寫" })),
      JSON.stringify(importRecord({ content: "kind 不合法", kind: "bogus" })),
      "這不是 JSON",
      JSON.stringify(importRecord({ content: "版本太新", schemaVersion: 2 })),
      JSON.stringify(importRecord({ content: "pinned 型別錯", pinned: "yes" })),
      JSON.stringify(importRecord({ content: "   " })),
    ];
    const rejected = await importNdjson(instance, `${lines.join("\n")}\n`);
    expect(rejected.status).toBe(400);
    expect(errorName(rejected.body)).toBe("ValidationError");
    const body = rejected.body as MemoryImportResponse;
    expect(body.dryRun).toBe(false);
    expect(body.total).toBe(6);
    expect(body.valid).toBe(1);
    expect(body.created).toBe(0);
    expect(body.invalid.map((item) => item.line)).toEqual([2, 3, 4, 5, 6]);
    for (const item of body.invalid) expect(item.reason.length).toBeGreaterThan(0);

    const after = await listMemoryRows(instance);
    expect(after).toHaveLength(1);
    expect(after[0]?.content).toBe("基準記憶");
    // 合法的那一行也完全沒有寫入。
    expect(JSON.stringify(after)).not.toContain("這筆合法但整批不能寫");
  });

  it("重複跳過：與既有記憶同 key 或同批次重複都不新增，計入 duplicates", async () => {
    server = await startTestServer();
    const instance = server.instance;
    await postMemory(instance, { content: "去重測試\n第二行", agent: "agent-c3", scope: "project", project: "proj-dup" });

    const imported = await importNdjson(
      instance,
      ndjson([
        // 只差空白／換行 → 正規化後同 key。
        importRecord({
          content: "  去重測試\r\n\r\n第二行\t ",
          agent: "agent-c3",
          scope: "project",
          project: "proj-dup",
        }),
        // 同批次第三、四行完全一樣：第一筆建立、第二筆視為重複。
        importRecord({ content: "批次內重複", agent: "agent-c3" }),
        importRecord({ content: "批次內重複", agent: "agent-c3" }),
      ]),
    );
    expect(imported.status).toBe(200);
    expect(imported.body).toEqual({
      dryRun: false,
      total: 3,
      valid: 3,
      invalid: [],
      duplicates: 2,
      redacted: 0,
      created: 1,
      wouldCreate: 0,
    });
    const listed = await listMemoryRows(instance);
    expect(listed).toHaveLength(2);
    expect(listed.filter((memory) => memory.content === "批次內重複")).toHaveLength(1);
  });

  it("空檔（0 行）與只有空白行 → 200 全 0", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const empty = await importNdjson(instance, "");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      dryRun: false,
      total: 0,
      valid: 0,
      invalid: [],
      duplicates: 0,
      redacted: 0,
      created: 0,
      wouldCreate: 0,
    });

    const whitespace = await importNdjson(instance, "\n\n   \r\n\t\n");
    expect(whitespace.status).toBe(200);
    expect((whitespace.body as MemoryImportResponse).total).toBe(0);
    expect(await listMemoryRows(instance)).toEqual([]);
  });

  it("超過 32 MiB → 413 PayloadTooLargeError，且不寫入", async () => {
    server = await startTestServer();
    const instance = server.instance;
    // 以 Content-Length 宣告超量（不真的傳 32 MiB，避免拖慢同機並行的其他測試）：
    // 伺服器必須在讀 body 前就用標頭拒絕，這也是實際上傳大檔時應有的行為。
    const rejected = await rawHttpRequest(instance.port, "/memories/import", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/x-ndjson",
        "content-length": String(MAX_MEMORY_IMPORT_BYTES + 1),
      },
    });
    expect(rejected.status).toBe(413);
    const bodyText = rejected.body.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    expect(errorName(JSON.parse(bodyText))).toBe("PayloadTooLargeError");
    expect(await listMemoryRows(instance)).toEqual([]);
  });
});

describe("記憶備份純函式", () => {
  it("serializeMemoriesExport：一行一筆、結尾換行、0 筆為空 Buffer；檔名為 memories-YYYYMMDD.ndjson", () => {
    const memory = (overrides: Partial<Memory>): Memory => ({
      id: 1,
      content: "內容",
      kind: "fact",
      scope: "global",
      project: null,
      agent: "agent-c3",
      supersedes: null,
      pinned: false,
      sourceSession: null,
      sourceMessage: null,
      createdAt: "2026-10-19T00:00:00.000Z",
      deletedAt: null,
      ...overrides,
    });
    expect(serializeMemoriesExport([]).byteLength).toBe(0);

    const buffer = serializeMemoriesExport([
      memory({ id: 1 }),
      memory({ id: 2, content: "第二筆", kind: "decision", pinned: true }),
    ]);
    const text = buffer.toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.split("\n").slice(0, -1);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION, id: 1 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 2, kind: "decision", pinned: true });

    expect(memoryExportFilename(new Date(2026, 9, 19))).toBe("memories-20261019.ndjson");
    expect(memoryExportFilename(new Date(2026, 0, 2))).toBe("memories-20260102.ndjson");
  });

  it("parseDryRunParam：未帶＝false；只接受 1／true", () => {
    expect(parseDryRunParam(null)).toBe(false);
    expect(parseDryRunParam("1")).toBe(true);
    expect(parseDryRunParam("true")).toBe(true);
    for (const value of ["0", "false", "TRUE", "yes", ""]) {
      expect(() => parseDryRunParam(value), value).toThrowError();
    }
  });

  it("planMemoryImport：BOM／CRLF／空行、忽略未知欄位、kind 預設 fact、scope 由 project 推定", () => {
    const text =
      "\uFEFF" +
      [
        JSON.stringify({ content: "第一筆", agent: "agent-c3", id: 999, createdAt: "2000-01-01" }),
        "",
        JSON.stringify({ content: "第二筆", agent: "agent-c3", project: "proj-c3", pinned: true, extra: "忽略" }),
        "   ",
        JSON.stringify({ content: "第三筆", agent: "agent-c3", scope: "global" }),
      ].join("\r\n");

    const plan = planMemoryImport(text);
    expect(plan.total).toBe(3);
    expect(plan.invalidCount).toBe(0);
    expect(plan.entries.map((entry) => entry.line)).toEqual([1, 3, 5]);
    expect(plan.entries[0]).toMatchObject({ kind: "fact", scope: "global", project: null, pinned: false });
    expect(plan.entries[1]).toMatchObject({ kind: "fact", scope: "project", project: "proj-c3", pinned: true });
    expect(plan.entries[2]).toMatchObject({ kind: "fact", scope: "global", project: null });

    const invalid = planMemoryImport(
      [
        "{",
        JSON.stringify({ content: "缺 agent" }),
        JSON.stringify({ content: "專案缺名稱", scope: "project" }),
      ].join("\n"),
    );
    expect(invalid.invalidCount).toBe(3);
    expect(invalid.invalid.map((item) => item.line)).toEqual([1, 2, 3]);
  });

  it("countImportDuplicates：比對既有未刪除記憶，同批次較早的重複也算", () => {
    const existing: Pick<Memory, "content" | "scope" | "project" | "agent" | "deletedAt">[] = [
      { content: "既有", scope: "global", project: null, agent: "agent-c3", deletedAt: null },
      { content: "已刪除", scope: "global", project: null, agent: "agent-c3", deletedAt: "2026-10-19T00:00:00.000Z" },
    ];
    const entries = [
      // 正規化後與既有相同（空白差異）。
      { content: "  既有 ", scope: "global" as const, project: null, agent: "agent-c3" },
      // 同批次第二筆重複。
      { content: "新內容", scope: "global" as const, project: null, agent: "agent-c3" },
      { content: "新內容", scope: "global" as const, project: null, agent: "agent-c3" },
      // 已刪除者不參與去重 → 不算重複。
      { content: "已刪除", scope: "global" as const, project: null, agent: "agent-c3" },
    ];
    expect(countImportDuplicates(entries, existing)).toBe(2);
  });
});
