import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * dev 模式：Vite dev server 只服務 UI，API 由 Core 服務提供。
 *
 * `server.proxy` 只在 dev 有效（production 由 Core 直接服務 `dist/`）；Core 必須用固定埠，
 * 因為 `MNEMOSHELF_PORT` 預設是 0（隨機埠），proxy 無從得知。用 `MNEMOSHELF_DEV_CORE` 覆寫。
 *
 * `changeOrigin: true`：Core 有 Host header 驗證（只接受 `127.0.0.1`／`localhost`／`[::1]`），
 * 轉發時把 `Host` 換成 target 的值（`127.0.0.1:8787`），否則會被回 403。
 */
const CORE_ORIGIN = process.env.MNEMOSHELF_DEV_CORE ?? "http://127.0.0.1:8787";

const API_PREFIXES = ["/health", "/roots", "/search", "/memories", "/diagnostics"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: Object.fromEntries(
      API_PREFIXES.map((prefix) => [prefix, { target: CORE_ORIGIN, changeOrigin: true }]),
    ),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
