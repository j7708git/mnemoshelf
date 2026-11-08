import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import type { RootPreview, IndexRootResult } from "@mnemoshelf/core";
import type { UnifiedSearchResult } from "../src/search.js";
import { api, makeTempDir, removeTempDir, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";

function wav(seconds: number): Buffer {
  const samples = Math.floor(seconds * 16000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / 20) * 5000), 44 + i * 2);
  return bytes;
}

let server: TestServer | undefined;
const directories: string[] = [];
afterEach(async () => {
  await server?.close(); server = undefined;
  for (const dir of directories.splice(0)) await removeTempDir(dir);
});

async function fixture(audio: boolean): Promise<{ id: number; dir: string }> {
  const dir = await makeTempDir("mnemoshelf-audio-http-"); directories.push(dir);
  await fs.writeFile(path.join(dir, "sample.wav"), wav(31.25));
  await fs.writeFile(path.join(dir, "unsupported.mp3"), "synthetic unsupported media");
  server = await startTestServer({ embedder: new FakeEmbedder({ audio }) });
  const created = await api(server.instance, "POST", "/roots", { body: { path: dir, modalities: ["audio"] } });
  expect(created.status).toBe(201);
  return { id: (created.body as { id: number }).id, dir };
}

describe("音訊 REST 產品流程", () => {
  it("預覽、索引、搜尋時間片段、播放來源、未變重跑與關閉模態清理", async () => {
    const { id } = await fixture(true);
    const preview = await api(server!.instance, "POST", `/roots/${id}/preview`);
    expect((preview.body as RootPreview).byKind.audio.count).toBe(1);
    expect((preview.body as RootPreview).skipped.some((entry) => entry.reason === "unsupported-audio-format")).toBe(true);
    const indexed = await api(server!.instance, "POST", `/roots/${id}/index`);
    expect(indexed.status).toBe(200);
    expect((indexed.body as IndexRootResult).processed).toBe(1);
    const found = await api(server!.instance, "POST", "/search", { body: { query: "sound", mode: "vector", rootIds: [id], k: 20 } });
    const hits = (found.body as UnifiedSearchResult).hits;
    expect(hits).toHaveLength(4);
    expect(hits.every((hit) => hit.type === "chunk" && hit.kind === "audio" && hit.media?.track === "audio")).toBe(true);
    expect(hits.some((hit) => hit.type === "chunk" && hit.media?.startSeconds === 30 && hit.media.endSeconds === 31.25)).toBe(true);
    const playback = await fetch(`${server!.instance.url}/roots/${id}/file?path=sample.wav`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(playback.status).toBe(200);
    expect(playback.headers.get("content-type")).toContain("audio/wav");
    expect(Buffer.from(await playback.arrayBuffer())).toEqual(wav(31.25));
    const rerun = await api(server!.instance, "POST", `/roots/${id}/index`);
    expect((rerun.body as IndexRootResult).skippedUnchanged).toBe(1);
    await api(server!.instance, "PATCH", `/roots/${id}`, { body: { modalities: [] } });
    await api(server!.instance, "POST", `/roots/${id}/index`);
    const cleared = await api(server!.instance, "POST", "/search", { body: { query: "sound", mode: "vector", rootIds: [id] } });
    expect((cleared.body as UnifiedSearchResult).hits).toEqual([]);
  });

  it("模型未支援時預覽與索引一致跳過音訊", async () => {
    const { id } = await fixture(false);
    const preview = await api(server!.instance, "POST", `/roots/${id}/preview`);
    expect((preview.body as RootPreview).byKind.audio.count).toBe(0);
    expect((preview.body as RootPreview).skipped.every((entry) => entry.reason === "unsupported-modality")).toBe(true);
    const indexed = await api(server!.instance, "POST", `/roots/${id}/index`);
    expect((indexed.body as IndexRootResult).processed).toBe(0);
  });

  it("播放端點保留授權、root 邊界、格式與大小防線", async () => {
    const { id, dir } = await fixture(true);
    const request = (relative: string, authenticated = true) => fetch(`${server!.instance.url}/roots/${id}/file?path=${encodeURIComponent(relative)}`, {
      headers: authenticated ? { authorization: `Bearer ${TEST_TOKEN}` } : {},
    });
    expect((await request("sample.wav", false)).status).toBe(401);
    expect((await request(path.join("..", "outside.wav"))).status).toBe(403);
    expect((await request("unsupported.mp3")).status).toBe(415);
    await fs.writeFile(path.join(dir, "bad.wav"), "broken WAV");
    expect((await request("bad.wav")).status).toBe(415);
    const handle = await fs.open(path.join(dir, "large.wav"), "w");
    await handle.truncate(10 * 1024 * 1024 + 1); await handle.close();
    expect((await request("large.wav")).status).toBe(413);
  });
});
