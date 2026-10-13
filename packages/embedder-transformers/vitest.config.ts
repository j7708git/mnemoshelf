import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 契約測試與 FakeEmbedder 皆在 core 的原始碼裡；直接以原始碼解析，
  // 讓測試不依賴 core 的 dist 是否已建置。
  resolve: {
    alias: [
      {
        find: "@mnemoshelf/core/testing",
        replacement: path.resolve(packageRoot, "../core/src/testing/index.ts"),
      },
      {
        find: "@mnemoshelf/core",
        replacement: path.resolve(packageRoot, "../core/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 真實模型測試（MNEMOSHELF_E2E=1）單一測試可能載入模型數秒到數十秒，放寬逾時。
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
