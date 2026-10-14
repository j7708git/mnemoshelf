/**
 * SQL 識別字的安全處理。
 *
 * schema 名稱由呼叫端提供（契約測試每個測試一個臨時 schema），因此**不得**直接字串拼接
 * 進 SQL。這裡只允許合法識別字（英數與底線、不以數字開頭），再用雙引號包起來。
 * 表名與欄名一律是程式內的常數，不經使用者輸入。
 */

/** 合法 SQL 識別字：英數與底線，且不以數字開頭。 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 驗證並回傳安全的識別字；不合法時拋錯（絕不放行拼接）。 */
export function assertSafeIdentifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`${what} 必須是合法 SQL 識別字（英數與底線、不以數字開頭）：收到 ${JSON.stringify(name)}`);
  }
  return name;
}

/** 組出帶 schema 的完整表名（雙引號包裹，避免大小寫與保留字問題）。 */
export function qualified(schema: string, table: string): string {
  return `"${assertSafeIdentifier(schema, "schema")}"."${assertSafeIdentifier(table, "table")}"`;
}
