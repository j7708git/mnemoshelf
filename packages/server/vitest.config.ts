import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 測試直接對 workspace 內的其他套件原始碼取用（與 `tsconfig.test.json` 的 `paths` 一致），
 * 因此 `pnpm test` 不依賴 `pnpm build` 的產物。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@mnemoshelf\/core\/testing$/, replacement: path.resolve(here, "../core/src/testing/index.ts") },
      { find: /^@mnemoshelf\/core$/, replacement: path.resolve(here, "../core/src/index.ts") },
      { find: /^@mnemoshelf\/embedder-transformers$/, replacement: path.resolve(here, "../embedder-transformers/src/index.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 真實模型的 e2e 較慢（載入 q4 模型約數十秒），給足以免 flaky。
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
