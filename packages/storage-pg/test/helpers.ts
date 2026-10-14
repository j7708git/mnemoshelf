/**
 * 契約測試的共用工具。
 *
 * 契約測試需要真的 PostgreSQL＋pgvector，因此以 testcontainers 起容器。
 * 為確保「沒有 Docker 的環境 `pnpm test` 仍全綠」，整組測試由環境變數 `MNEMOSHELF_PG` 閘控：
 * 未設 `MNEMOSHELF_PG=1` 時整個 suite 標為 skip，不會啟動容器、不會連網。
 */
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { Pool } from "pg";

/** 是否啟用 PostgreSQL 契約測試（需 Docker）。 */
export const PG_ENABLED = process.env.MNEMOSHELF_PG === "1";

/** 測試用的 pgvector image：完全鎖定的 tag，不用浮動的 `pg18`。 */
export const PG_IMAGE = "pgvector/pgvector:0.8.7-pg18-bookworm";

/** 跳過時顯示的訊息（讓輸出裡看得到原因）。 */
export const PG_SKIP_REASON =
  "未設 MNEMOSHELF_PG=1（PostgreSQL 契約測試需要 Docker 與 pgvector image）；已跳過";

if (!PG_ENABLED) {
  console.info(`[storage-pg] ${PG_SKIP_REASON}`);
}

/** 已啟動的容器型別（由 `start()` 的回傳推導，不依賴特定型別名稱）。 */
export type StartedPgContainer = Awaited<ReturnType<PostgreSqlContainer["start"]>>;

/** 起一個 throwaway PostgreSQL 容器（pgvector image）。 */
export async function startPgContainer(): Promise<StartedPgContainer> {
  return await new PostgreSqlContainer(PG_IMAGE).start();
}

/**
 * 建一個全新的臨時 schema 並回傳其名稱。
 * 契約要求「每個測試拿到全新、獨立的實例」，用獨立 schema 隔離最快也最乾淨。
 */
export async function createFreshSchema(pool: Pool): Promise<string> {
  const schema = `t_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`create schema "${schema}"`);
  return schema;
}
