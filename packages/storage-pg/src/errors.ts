/**
 * 本套件專屬的具名錯誤型別（比照 `@mnemoshelf/core` 的風格：一律 Error 子類別、訊息用繁體中文、
 * 可安全放進訊息的資訊才放訊息，其餘放欄位）。
 *
 * 這裡只放「只有 PostgreSQL 後端才會遇到」的錯誤；維度／正規化等跨後端共通的錯誤仍由 core 定義。
 */

/**
 * 既有的 `vectors` 表其 `embedding` 欄位維度與本次 `migrate()` 指定的 `dim` 不符。
 *
 * `create table if not exists` 對「表已存在但欄位型別不同」既不會報錯、也不會改型別，
 * 若不先檢查，維度不符會延到寫入／查詢時才以 PostgreSQL 原始錯誤爆出。
 */
export class VectorColumnDimensionError extends Error {
  /** 本次 `migrate()` 指定的維度。 */
  readonly expected: number;
  /** 既有欄位宣告的維度；無法從型別字串判定時為 `null`（例如未帶維度的 `vector`）。 */
  readonly actual: number | null;
  /** 既有欄位的完整型別字串（例如 `vector(512)`）。 */
  readonly actualType: string;
  /** 資料表所在的 schema。 */
  readonly schema: string;
  /** 表名。 */
  readonly table: string;

  constructor(expected: number, actual: number | null, actualType: string, schema: string, table: string) {
    const actualText = actual === null ? `無法判定（型別 ${actualType}）` : `${actual} 維`;
    super(`向量欄位維度不符：${schema}.${table}.embedding 預期 ${expected} 維，實際 ${actualText}`);
    this.name = "VectorColumnDimensionError";
    this.expected = expected;
    this.actual = actual;
    this.actualType = actualType;
    this.schema = schema;
    this.table = table;
  }
}
