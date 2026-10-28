/**
 * server 關閉與行程結束的可測流程（main.ts 的 `closeServerOnly()`／`shutdown()`）。
 *
 * 為什麼抽出來：`main.ts` 直接 import electron，vitest 不能載入；把「只關 server、
 * 不呼叫 app.exit」這條規則放在純模組，才能用 spy 驗證（驗收條件 4）。
 *
 * 行為：
 * - `closeServerOnly()`：只呼叫一次注入的 `closeServer`；**不呼叫 `exit`**、不設定
 *   `quitting`、不刪 runtime 檔（server 的 close 自己處理）。可重入：同時呼叫多次
 *   會共用同一個 promise；**關閉失敗時所有呼叫者都收到同一個 rejection**（呼叫端才能
 *   真正取消後續的備份／安裝）。
 * - `shutdown(code)`：先 `closeServerOnly()`，再呼叫 `exit(code)`（維持原本行為）。
 *   關閉失敗仍會照樣結束（記錄後 exit），不讓應用卡在關不掉行程的狀態。
 */

export interface ServerLifecycleDeps {
  /** 真正關閉 server（main 會在這裡把 server 設為 null、允許視窗關閉）。 */
  closeServer: () => Promise<void>;
  /** 結束行程（main 傳 `app.exit`）。 */
  exit: (code: number) => void;
  /** 關閉後、結束前的收尾（main 用來印授權統計）。 */
  beforeExit?: () => void;
  log?: (message: string) => void;
}

export interface ServerLifecycle {
  /**
   * 只關 server；可重入，永遠不會呼叫 `exit`。
   *
   * 關閉失敗時 reject；並行／後續呼叫會拿到同一個 rejected promise，不會重試。
   */
  closeServerOnly(): Promise<void>;
  /** 關 server 後以指定退出碼結束行程；關閉失敗也會結束。 */
  shutdown(code: number): Promise<void>;
}

export function createServerLifecycle(deps: ServerLifecycleDeps): ServerLifecycle {
  const log = deps.log ?? (() => undefined);
  let closing: Promise<void> | null = null;

  async function closeServerOnly(): Promise<void> {
    if (closing !== null) return closing;
    closing = (async () => {
      try {
        await deps.closeServer();
      } catch (error) {
        log(`關閉服務時發生錯誤：${error instanceof Error ? error.message : String(error)}`);
        // 讓 install() 能依這個失敗取消備份／安裝；shutdown() 會自行 catch 後照樣結束。
        throw error;
      }
    })();
    return closing;
  }

  async function shutdown(code: number): Promise<void> {
    try {
      await closeServerOnly();
    } catch {
      // closeServerOnly 已記錄；關閉失敗不阻止結束（沿用原本 shutdown 的行為）。
    }
    deps.beforeExit?.();
    deps.exit(code);
  }

  return { closeServerOnly, shutdown };
}
