# @mnemoshelf/web

Mnemoshelf 的 Web UI：**Vite + React + Tailwind CSS v4**（＋ `@tanstack/react-virtual`）。
build 產物（`dist/`）由 `@mnemoshelf/server` 同源提供，因此 UI 與 API 共用同一個
`127.0.0.1` 入口，不需要 CORS。

## 本卡範圍（M3：檔案總管、搜尋與記憶管理）

- token 輸入頁、連線狀態、roots 清單（可選取與移除）。
- **加入資料夾引導**：輸入路徑 → `POST /roots` → 預覽統計（`POST /roots/:id/preview`）→
  「開始索引」→ 背景索引 ＋ 輪詢 `GET /roots/:id/index/status` 顯示進度 → 完成。
- **虛擬化目錄樹**：展開時才載入子項（`GET /roots/:id/entries`，lazy），以
  `@tanstack/react-virtual` 虛擬化（節點多時不爆 DOM）。
- **檔案預覽**：文字（`GET /roots/:id/file`，截斷會標明）與圖片（`GET /roots/:id/thumb` 縮圖，
  可切換原圖）。圖片一律 `fetch`＋blob URL（`<img src>` 帶不了 `Authorization`），
  不再使用時 `URL.revokeObjectURL`。
- **統一搜尋**：模式選擇器（`vector`／`hybrid`／`keyword`，**UI 預設 `hybrid`**，含記憶命中；
  server 的 `/search` 預設仍是 `vector`）；結果區分檔案塊與記憶，並顯示來源（root／路徑／分數、
  記憶的 agent／範圍）；點檔案結果在右側以既有 `FilePreview` 開預覽。
- **記憶管理**：列表（`pinned` 標示、釘選優先排序）、釘選／取消（`POST /memories/:id/pin`）、
  編輯（走 supersedes：`POST /memories` 帶 `supersedes` 產生新版本並取代舊版）、
  刪除（確認步驟；軟刪除）、看來源（寫入者／種類／範圍／取代關係／建立時間）。

## 導覽

連線後有三個主要檢視（`App.tsx` 的頂部分頁）：**檔案總管**、**搜尋**、**記憶管理**。
搜尋畫面在上方切換模式；記憶管理以 `pinned` 優先、其次 `createdAt` 由新到舊排序。

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
（只接受 `127.0.0.1`／`localhost`／`[::1]`／`*.localhost`，可帶埠號），轉發時 `Host` 會被換成 target 的值。

## token 處理

**瀏覽器模式**（直接開服務的網址）：使用者貼上一次 → 存 `sessionStorage`（只活到分頁關閉）→
每請求帶 `Authorization: Bearer <token>`；收到 `401` 會清除 token，並由 `apiFetch` 派送全域事件
`mnemoshelf:unauthorized`（`api.ts` 的 `UNAUTHORIZED_EVENT`），`App.tsx` 監聽後切回貼
token 畫面，各面板不必各自處理 401。

**桌面模式**（Electron 殼）：preload 掛了 `window.mnemoshelfDesktop` 時，token 由應用程式自己管
（`safeStorage` 加密保存，main process 以 `webRequest` 注入標頭），UI 不出現 token 表單、
也沒有「登出」；401 會顯示可重試的錯誤（而不是回頭要求貼 token）。見 `desktop.ts`。

**token 絕不進 URL、絕不經 `VITE_*` 環境變數**（`VITE_*` 會被 build 期內嵌進 bundle），
也**不會**經過 desktop bridge（bridge 只回傳保存狀態）。

## 桌面模式專屬畫面

`BootstrapScreen.tsx`（首次啟動的模型下載進度／重試）只在桌面模式顯示；
`SettingsPanel.tsx` 的桌面專屬區塊（開機自啟開關、token 保存狀態、版本）只在桌面模式顯示，
「匯出診斷資訊」則兩種模式都可用；瀏覽器模式完全不受影響（同一個 build 支援兩種環境）。

## 測試

web 套件沒有單元測試工具鏈（未核准 `vitest`／`jsdom` 等依賴）；行為以
`@mnemoshelf/server` 的端點整合測試與瀏覽器實測涵蓋。目錄樹的純邏輯
（`flattenTree.ts`）刻意抽成與 React 無關的純函式，未來若引入測試工具鏈可直接測。
