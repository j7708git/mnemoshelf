# @mnemoshelf/web

Mnemoshelf 的 Web UI（M3 第一塊骨架）：**Vite + React + Tailwind CSS v4**。
build 產物（`dist/`）由 `@mnemoshelf/server` 同源提供，因此 UI 與 API 共用同一個
`127.0.0.1` 入口，不需要 CORS。

## 本卡範圍

- token 輸入頁、連線狀態、roots 清單（`GET /roots`）。
- 尚未提供：加入／移除資料夾、目錄樹、檔案預覽、搜尋、記憶（後續卡）。

## 開發

```bash
pnpm --filter @mnemoshelf/web run dev       # http://127.0.0.1:5173
pnpm --filter @mnemoshelf/web run build     # 產出 dist/
pnpm --filter @mnemoshelf/web run typecheck
```

dev 模式需要 Core 用**固定埠**（`MNEMOSHELF_PORT` 預設 0 是隨機埠，proxy 無從得知）：

```bash
MNEMOSHELF_TOKEN=<token> MNEMOSHELF_PORT=8787 pnpm --filter @mnemoshelf/server run serve
MNEMOSHELF_DEV_CORE=http://127.0.0.1:8787 pnpm --filter @mnemoshelf/web run dev
```

`vite.config.ts` 的 `server.proxy` 用 `changeOrigin: true`：Core 有 Host header 驗證
（只接受 `127.0.0.1`／`localhost`／`[::1]`），轉發時 `Host` 會被換成 target 的值。

## token 處理

使用者貼上一次 → 存 `sessionStorage`（只活到分頁關閉）→ 每請求帶
`Authorization: Bearer <token>`；收到 `401` 清除並回到貼 token 畫面。

**token 絕不進 URL、絕不經 `VITE_*` 環境變數**（`VITE_*` 會被 build 期內嵌進 bundle）。
理由與替代方案比較見 `project-notes/projects/mnemoshelf/research/web-ui-stack.md` §Q5。
M4（Electron）會改用 `webRequest` 注入標頭，讓 token 完全不進 renderer。

## 測試

本卡未為 web 加測試工具鏈（未核准 `vitest`／`jsdom` 等依賴）；行為以
`@mnemoshelf/server` 的靜態服務／Host 驗證測試與瀏覽器實測涵蓋。
