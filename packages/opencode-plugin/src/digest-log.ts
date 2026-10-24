/**
 * digest 的檔案型診斷紀錄。
 *
 * 宿主（OpenCode／OpenChamber）不一定會把外掛的 console 輸出寫進 log，事後無法判斷
 * digest 是「慢」還是「被拒絕」。這裡把**每次嘗試**寫成一行 JSON，放在使用者狀態目錄，
 * 讓使用者可以直接把檔案交給人排查。
 *
 * 邊界（刻意設計）：
 * - 只記 digest：不記召回、不記對話與卡片內容、不記 prompt、token。
 * - `session` 只放 sessionID 的 hash 前 8 碼（可關聯同一個 session，但不留原始 id）。
 * - `reason` 只放原因碼或 `<name>: <message>`，截到 200 字元。
 * - 目錄 `0700`、檔案 `0600`；單檔上限 1 MiB，超過就輪替成 `digest.log.1`（只留一份）。
 * - 寫入失敗由呼叫端完全吞掉：診斷紀錄不得影響 digest 或 session。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { truncateChars } from "./text.js";

/** 診斷紀錄的目錄名（位於使用者狀態目錄下）。 */
export const DIGEST_LOG_DIR_NAME = "mnemoshelf-plugin";

/** 診斷紀錄的檔名。 */
export const DIGEST_LOG_FILE_NAME = "digest.log";

/** 單檔大小上限（1 MiB）；超過就輪替成 `<檔名>.1`。 */
export const DIGEST_LOG_MAX_BYTES = 1024 * 1024;

/** `reason` 的長度上限（與 `/memory` 的失敗原因一致）。 */
export const DIGEST_LOG_MAX_REASON_CHARS = 200;

/** 目錄權限（僅所有者可進入）。 */
export const DIGEST_LOG_DIR_MODE = 0o700;

/** 檔案權限（僅所有者可讀寫）。 */
export const DIGEST_LOG_FILE_MODE = 0o600;

export interface DigestLogPathInput {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

/**
 * 診斷紀錄檔的預設路徑：
 * `${XDG_STATE_HOME:-<home>/.local/state}/mnemoshelf-plugin/digest.log`。
 *
 * `XDG_STATE_HOME` 只在它是絕對路徑時採用（XDG 規範要求絕對路徑）。
 * 路徑一律用目標平台的 `path` 規則組合，不假設分隔符。
 */
export function digestLogPath(input: DigestLogPathInput = {}): string {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? os.homedir();
  const p = platform === "win32" ? path.win32 : path.posix;
  const configured = typeof env.XDG_STATE_HOME === "string" ? env.XDG_STATE_HOME.trim() : "";
  const stateRoot = configured !== "" && p.isAbsolute(configured) ? configured : p.join(home, ".local", "state");
  return p.join(stateRoot, DIGEST_LOG_DIR_NAME, DIGEST_LOG_FILE_NAME);
}

/** sessionID → 固定 8 碼 hex（同一 session 可關聯，但不留原始 id）。 */
export function digestSessionHash(sessionID: string): string {
  return createHash("sha256").update(sessionID).digest("hex").slice(0, 8);
}

export type DigestLogState = "ok" | "skipped" | "failed";

/** 單張卡的寫入結果（只記角色、狀態與 HTTP 狀態碼，不含內容）。 */
export interface DigestLogCard {
  role: "turn" | "item";
  state: "ok" | "duplicate" | "failed";
  /** HTTP 狀態碼（只有 failed 且拿得到時才有）。 */
  status?: number;
}

/** 每次 digest 嘗試寫一行；欄位固定，順序固定（方便人眼與 grep）。 */
export interface DigestLogEntry {
  /** 嘗試完成的時間（ISO 8601）。 */
  at: string;
  /** sessionID 的 hash 前 8 碼。 */
  session: string;
  state: DigestLogState;
  /** 只放原因碼或 `<name>: <message>`（≤200 字元）。 */
  reason?: string;
  /** `<providerID>/<modelID>`；沒有設定模型時是 `none`。 */
  model: string;
  /** 這次嘗試花費的毫秒數（失敗時就是實際等待時間）。 */
  latencyMs: number;
  /** 模型候選的卡片數；失敗或跳過時為 0。 */
  items: number;
  /** 實際寫入的卡片數（**不含** duplicate）；失敗或跳過時為 0。 */
  written: number;
  /** server 回 `duplicate: true` 的卡數（可選；舊格式沒有）。 */
  duplicates?: number;
  /** 卡片寫入失敗數（可選；舊格式沒有）。 */
  failed?: number;
  /** 逐卡結果，順序與送出順序一致（可選；舊格式沒有）。 */
  cards?: readonly DigestLogCard[];
}

/** 把一筆紀錄轉成單行 JSON（不含換行；`reason` 會截短）。 */
export function formatDigestLogLine(entry: DigestLogEntry): string {
  const payload: Record<string, unknown> = {
    at: entry.at,
    session: entry.session,
    state: entry.state,
  };
  if (entry.reason !== undefined) {
    payload.reason = truncateChars(entry.reason.replace(/\s+/g, " ").trim(), DIGEST_LOG_MAX_REASON_CHARS);
  }
  payload.model = entry.model;
  payload.latencyMs = entry.latencyMs;
  payload.items = entry.items;
  payload.written = entry.written;
  // 新欄位只在有值時輸出：舊讀者仍能解析既有格式。
  if (entry.duplicates !== undefined) payload.duplicates = entry.duplicates;
  if (entry.failed !== undefined) payload.failed = entry.failed;
  if (entry.cards !== undefined) {
    payload.cards = entry.cards.map((card) => ({
      role: card.role,
      state: card.state,
      ...(card.status === undefined ? {} : { status: card.status }),
    }));
  }
  return JSON.stringify(payload);
}

export interface AppendDigestLogOptions {
  /** 大小上限（測試用；預設 1 MiB）。 */
  maxBytes?: number;
  dirMode?: number;
  fileMode?: number;
}

/**
 * 追加一行到診斷紀錄；超過上限時先把現有檔案輪替成 `<file>.1`。
 *
 * 這裡不吞錯（呼叫端負責 `catch`）——測試才能驗證「真的寫不進去」的路徑，
 * 正式流程仍在 `digest.ts` 統一吞掉。
 */
export async function appendDigestLog(
  file: string,
  line: string,
  options: AppendDigestLogOptions = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? DIGEST_LOG_MAX_BYTES;
  const dirMode = options.dirMode ?? DIGEST_LOG_DIR_MODE;
  const fileMode = options.fileMode ?? DIGEST_LOG_FILE_MODE;
  const payload = line.endsWith("\n") ? line : `${line}\n`;
  const bytes = Buffer.byteLength(payload, "utf8");

  await fs.mkdir(path.dirname(file), { recursive: true, mode: dirMode });

  try {
    const stat = await fs.stat(file);
    if (stat.size > 0 && stat.size + bytes > maxBytes) {
      const rotated = `${file}.1`;
      // Windows 的 rename 不能覆蓋既有檔；先刪再改名（只留一份）。
      await fs.rm(rotated, { force: true });
      await fs.rename(file, rotated);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await fs.appendFile(file, payload, { encoding: "utf8", mode: fileMode });
}
