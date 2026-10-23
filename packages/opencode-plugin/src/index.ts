/**
 * `@mnemoshelf/opencode-plugin` 的入口。
 *
 * `id` 會出現在 `opencode plugin list`；`setup` 只註冊 hook 與指令，連線檢查在背景進行，
 * 因此不會拖慢 OpenCode 的 location 啟動。所有召回與 digest 失敗都 fail-open。
 */
import { Plugin } from "@opencode/plugin";

import { createMemoryRuntime } from "./recall.js";
import type { PluginContextLike } from "./types.js";

export default Plugin.define({
  id: "mnemoshelf.memory",
  async setup(ctx) {
    // 真正的 `Context` 是 `@opencode/plugin` 的完整型別；核心邏輯只需要其中一小塊，
    // 以結構型別描述才能在一般 Node（測試）裡用假 ctx 重跑。
    return createMemoryRuntime(ctx as unknown as PluginContextLike);
  },
});

export { createMemoryRuntime } from "./recall.js";
export { injectMemoryBlock } from "./inject.js";
export { resolveProjectName, normalizeProjectName } from "./project.js";
export { parseDigestModel, readSettings, resolveConnection, runtimeCandidates } from "./config.js";
export {
  buildDigestPrompt,
  createDigestRuntime,
  parseDigestItems,
  resolveDigestTurn,
  stripMemoryContext,
} from "./digest.js";
