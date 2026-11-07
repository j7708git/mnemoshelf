import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import server from "../../vitest.config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  ...server,
  resolve: {
    alias: [
      ...server.resolve!.alias as { find: RegExp; replacement: string }[],
      {
        find: /^@huggingface\/transformers$/,
        replacement: path.resolve(here, "..", "..", "..", "embedder-transformers", "node_modules",
          "@huggingface", "transformers", "dist", "transformers.node.mjs"),
      },
    ],
  },
  test: {
    ...server.test,
    include: ["eval/raw-memory/*.test.ts"],
    testTimeout: 900_000,
  },
});
