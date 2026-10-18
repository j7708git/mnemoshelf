/**
 * 機密遮罩的**轉出 shim**。
 *
 * 實作已搬到 `@mnemoshelf/core` 的 `privacy/secret-masking.ts`（純函式、無 server 相依，
 * 記憶與檔案索引共用同一組 curated 規則）。這裡只保留原本的 import 路徑與 server 的
 * 公開 API（`src/index.ts` 的 re-export），呼叫端不需要改動。
 *
 * 規則與行為以 core 的實作為準；本檔不得再放任何規則。
 */
export { containsRedacted, maskSecrets, REDACTED_PREFIX } from "@mnemoshelf/core";
export type { MaskSecretsResult, SecretKind } from "@mnemoshelf/core";
