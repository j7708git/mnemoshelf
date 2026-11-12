/** 真 Electron main process；沒有 BrowserWindow，也不載入使用者安裝或設定。 */
import { app } from "electron";
import path from "node:path";
import os from "node:os";

const id = process.env.WEBGPU_CASE_ID;
if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Electron case id 無效");
app.setPath("userData", path.join(process.cwd(), ".tmp", "webgpu-integration", "electron-user-data", id));
app.whenReady().then(async () => {
  try {
    await import("./case.mjs");
    app.exit(Number(process.exitCode ?? 0));
  } catch (error) {
    console.error(JSON.stringify({ name: error?.name, message: String(error?.message ?? "Electron 驗收失敗").replaceAll(process.cwd(), "<repo>").replaceAll(os.homedir(), "<home>") }));
    app.exit(1);
  }
});
