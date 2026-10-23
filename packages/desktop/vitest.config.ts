import { defineConfig } from "vitest/config";

/**
 * 只測純邏輯（路徑解析、token 決策、native 模組探測的輸出格式）。
 * 真正的「打包產物跑起來」由 `scripts/smoke.mjs` 驅動（見 `docs/building.md` 的「發版（CI）」一節）。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
