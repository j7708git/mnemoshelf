/**
 * 召回與 digest 共用的字面常數。
 *
 * 放在獨立模組是為了讓 `recall.ts` 與 `digest.ts` 都能引用，不必互相 import
 * （兩者功能上互相獨立，只有 `recall.ts` 的 runtime 會組裝 digest）。
 */

/** 注入區塊的開頭（用來避免同一則訊息被重複注入，也用它認出「整段是外掛自己的內容」）。 */
export const BLOCK_MARKER = '<memory-context source="mnemoshelf"';

/** 注入區塊的開頭標籤（含沒有 `source` 屬性的變體；digest 剝除時用）。 */
export const MEMORY_CONTEXT_OPEN = "<memory-context";

/**
 * 指令輸出的固定前綴。
 *
 * synthetic 訊息在 `event.messages` 是 role="user"；若不加標記，下一次模型請求會把
 * 狀態文字當成使用者訊息，召回流程還會再拿它去查一次。召回與 digest 看到這個前綴就直接跳過。
 */
export const STATUS_SENTINEL = "[[mnemoshelf-status]]";

/** 舊版宿主沒有 `type`／`synthetic` 欄位時，Plan mode 提醒訊息的固定開頭。 */
export const SYSTEM_REMINDER_PREFIX = "<system-reminder>";
