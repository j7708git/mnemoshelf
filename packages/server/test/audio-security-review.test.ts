/** 音訊 HTTP 獨立驗收：只使用暫存合成 WAV，確認新增讀取路徑沒有放寬既有邊界。 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import { api, makeTempDir, removeTempDir, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";

let server: TestServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function wav(): Buffer {
  const data = Buffer.alloc(32044);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(32000, 40);
  return data;
}

async function fixture(audio = true): Promise<{ dir: string; id: number }> {
  server = await startTestServer({ embedder: new FakeEmbedder({ audio }) });
  const dir = await makeTempDir("mnemoshelf-audio-review-");
  dirs.push(dir);
  await fs.writeFile(path.join(dir, "sample.wav"), wav());
  const created = await api(server.instance, "POST", "/roots", { body: { path: dir, modalities: ["text", "image", "audio"] } });
  expect(created.status).toBe(201);
  return { dir, id: (created.body as { id: number }).id };
}

async function file(id: number, rel: string, authorized = true): Promise<Response> {
  return fetch(`${server!.instance.url}/roots/${id}/file?path=${encodeURIComponent(rel)}`, {
    headers: authorized ? { authorization: `Bearer ${TEST_TOKEN}` } : {},
  });
}

describe("音訊 HTTP 邊界獨立審查", () => {
  it("音訊預覽需要token，合法來源回原位元組及WAV型別", async () => {
    const { id } = await fixture();
    const unauthenticated = await file(id, "sample.wav", false);
    expect(unauthenticated.status).toBe(401);
    const authenticated = await file(id, "sample.wav");
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get("content-type")).toContain("audio/wav");
    expect(Buffer.from(await authenticated.arrayBuffer())).toEqual(wav());
  });

  it("相對路徑逃逸與黑名單音訊拒絕，回應不帶私有絕對路徑", async () => {
    const { dir, id } = await fixture();
    await fs.mkdir(path.join(dir, ".ssh"));
    await fs.writeFile(path.join(dir, ".ssh", "private.wav"), wav());
    for (const rel of [path.join("..", "outside.wav"), path.join(".ssh", "private.wav")]) {
      const response = await file(id, rel);
      expect([400, 403]).toContain(response.status);
      expect(await response.text()).not.toContain(dir);
    }
  });

  it("指向root外的WAV符號連結拒絕", async (context) => {
    const { dir, id } = await fixture();
    const outside = await makeTempDir("mnemoshelf-audio-outside-");
    dirs.push(outside);
    await fs.writeFile(path.join(outside, "other.wav"), wav());
    try { await fs.symlink(path.join(outside, "other.wav"), path.join(dir, "escape.wav"), "file"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; }
      throw error;
    }
    const response = await file(id, "escape.wav");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(outside);
  });

  it("損壞與未支援音訊不會以成功或文字回傳", async () => {
    const { dir, id } = await fixture();
    await fs.writeFile(path.join(dir, "bad.wav"), "not audio");
    await fs.writeFile(path.join(dir, "other.mp3"), "placeholder");
    const bad = await file(id, "bad.wav");
    const unsupported = await file(id, "other.mp3");
    expect(bad.status).toBe(415);
    expect(unsupported.status).toBe(415);
    expect(await bad.text()).not.toContain("not audio");
  });

  it("音訊超過10MiB預覽上限回413", async () => {
    const { dir, id } = await fixture();
    await fs.truncate(path.join(dir, "sample.wav"), 10 * 1024 * 1024 + 1);
    expect((await file(id, "sample.wav")).status).toBe(413);
  });

  it("未具音訊能力時preview不宣稱將會索引", async () => {
    const { id } = await fixture(false);
    const response = await api(server!.instance, "POST", `/roots/${id}/preview`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ byKind: { audio: { count: 0 } }, skipped: [{ relPath: "sample.wav", reason: "unsupported-modality" }] });
  });

  it("索引後search保留時間定位，關閉音訊並重跑才回收命中", async () => {
    const { id } = await fixture();
    const indexed = await api(server!.instance, "POST", `/roots/${id}/index`);
    expect(indexed.status).toBe(200);
    expect(indexed.body).toMatchObject({ processed: 1, failedFiles: [] });
    const searched = await api(server!.instance, "POST", "/search", { body: { query: "聲音", mode: "vector", rootIds: [id] } });
    expect(searched.status).toBe(200);
    const hits = (searched.body as { hits: { media?: unknown; text: unknown }[] }).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ text: null, media: { track: "audio", startSeconds: 0, endSeconds: 1 } });
    const updated = await api(server!.instance, "PATCH", `/roots/${id}`, { body: { modalities: ["text", "image"] } });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ modalities: ["text", "image"] });
    const rerun = await api(server!.instance, "POST", `/roots/${id}/index`);
    expect(rerun.body).toMatchObject({ processed: 0, removedFiles: 1 });
    const after = await api(server!.instance, "POST", "/search", { body: { query: "聲音", mode: "vector", rootIds: [id] } });
    expect((after.body as { hits: unknown[] }).hits).toEqual([]);
  });
});
