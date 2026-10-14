/**
 * 測試共用工具：暫存目錄、合成 root、啟動測試伺服器、HTTP 呼叫。
 *
 * 一律使用 `os.tmpdir()` 下的合成資料，結束後刪除；不讀取任何使用者檔案。
 */
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { type Embedder, type EmbedderInfo, type ImageInput, type ProbeResult } from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import { createServer, type MnemoshelfServer } from "../src/index.js";

/** 測試用 token（合成值，不是任何真實憑證）。 */
export const TEST_TOKEN = "test-token-2f8c1a9e";

/** 測試資料裡出現的關鍵字（合成字串）。 */
export const NOTE_TOKEN = "zorblat";

/** 建立暫存目錄。 */
export async function makeTempDir(prefix = "mnemoshelf-server-"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 刪除暫存目錄（best effort）。 */
export async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** 最小的合法 PNG 位元組（8 bytes 簽章＋無內容）；FakeEmbedder 只用位元組當雜湊輸入。 */
const FAKE_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 建立一個合成 root：一個 `.md`、一個程式碼檔與一張圖片。
 * 圖片預設**不在**索引模態內（docs：image 需手動開啟）。
 */
export async function makeFixtureRoot(prefix = "mnemoshelf-root-"): Promise<string> {
  const dir = await makeTempDir(prefix);
  await fs.mkdir(path.join(dir, "code"));
  await fs.writeFile(
    path.join(dir, "notes.md"),
    `# 索引筆記\n\n${NOTE_TOKEN} 是測試用的關鍵字，用來驗證關鍵字搜尋。\n`,
    "utf8",
  );
  await fs.writeFile(path.join(dir, "code", "app.ts"), `export const ${NOTE_TOKEN}Value = 42;\n`, "utf8");
  await fs.writeFile(path.join(dir, "pic.png"), FAKE_PNG);
  return dir;
}

/** 每次嵌入都延遲的 embedder（驗證「索引進行中 → 409」）。 */
export class SlowEmbedder implements Embedder {
  private readonly inner = new FakeEmbedder();

  constructor(private readonly delayMs: number) {}

  get info(): EmbedderInfo {
    return this.inner.info;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.inner.embedQuery(text);
  }

  async embedDocument(text: string, title?: string): Promise<Float32Array> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.embedDocument(text, title);
  }

  async embedImage(image: ImageInput): Promise<Float32Array> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.embedImage(image);
  }

  async probe(): Promise<ProbeResult> {
    return this.inner.probe();
  }

  async dispose(): Promise<void> {
    return this.inner.dispose();
  }
}

export interface TestServer {
  instance: MnemoshelfServer;
  dataDir: string;
  /** 關閉服務並刪除暫存資料目錄。 */
  close(): Promise<void>;
}

/** 啟動測試伺服器（FakeEmbedder＋port 0＋暫存資料目錄）。 */
export async function startTestServer(
  options: { embedder?: Embedder; homeDir?: string; webDir?: string } = {},
): Promise<TestServer> {
  const dataDir = await makeTempDir("mnemoshelf-data-");
  const instance = await createServer({
    env: {},
    token: TEST_TOKEN,
    dataDir,
    port: 0,
    embedder: options.embedder ?? new FakeEmbedder(),
    homeDir: options.homeDir ?? os.homedir(),
    ...(options.webDir === undefined ? {} : { webDir: options.webDir }),
  });
  return {
    instance,
    dataDir,
    async close(): Promise<void> {
      await instance.close();
      await removeTempDir(dataDir);
    },
  };
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

/** 呼叫 REST API；`token` 傳 null 表示刻意不帶 Authorization。 */
export async function api(
  instance: MnemoshelfServer,
  method: string,
  apiPath: string,
  options: { body?: unknown; token?: string | null } = {},
): Promise<ApiResponse> {
  const token = options.token === undefined ? TEST_TOKEN : options.token;
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${instance.url}${apiPath}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() === "" ? null : (JSON.parse(text) as unknown),
    headers: response.headers,
  };
}

/** 讀出錯誤回應的 `error.name`（測試輔助）。 */
export function errorName(body: unknown): string {
  const record = body as { error?: { name?: unknown } } | null;
  return typeof record?.error?.name === "string" ? record.error.name : "";
}

/**
 * 直接以 TCP socket 送**原始** HTTP 請求。
 *
 * 為什麼不用 `fetch`：畸形 request-target（`//[`、`/%`）在客戶端就會被 `new URL` 或
 * fetch 自己拒絕，送不出去；要驗證伺服器端行為只能自己寫 bytes。
 */
export async function rawHttpRequest(
  port: number,
  requestTarget: string,
  options: { method?: string; host?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; statusLine: string; body: string }> {
  const method = options.method ?? "GET";
  const host = options.host ?? "127.0.0.1";
  const extra = Object.entries(options.headers ?? {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const head = `${method} ${requestTarget} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`;

  return await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(head);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000);
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("rawHttpRequest 逾時"));
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const statusLine = data.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1]);
      resolve({ status: Number.isFinite(status) ? status : 0, statusLine, body: data });
    });
  });
}
