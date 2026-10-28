import { defineConfig } from "vitest/config";

/**
 * 只測純邏輯（更新狀態的去重、進度文字與 bridge 形狀判斷）。
 * UI 行為由真正的瀏覽器／桌面 smoke 驗證，不在這裡模擬 DOM。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
