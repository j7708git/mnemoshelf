import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 契約測試與 port 型別都在 core 的原始碼裡；直接以原始碼解析，
  // 讓測試不依賴 core 的 dist 是否已建置（與 embedder-transformers 同一套做法）。
  resolve: {
    alias: [
      {
        find: /^@mnemoshelf\/core\/testing$/,
        replacement: path.resolve(packageRoot, "../core/src/testing/index.ts"),
      },
      {
        find: /^@mnemoshelf\/core$/,
        replacement: path.resolve(packageRoot, "../core/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 契約測試需要 testcontainers 起 PostgreSQL 容器：首跑要下載 image（數百 MB），
    // 之後冷啟也要數秒，因此逾時放寬。
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
