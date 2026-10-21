// OpenCode 的 local plugin 載入器要求「外掛目錄根」有 index.js；
// 這個檔案只把載入導向 build 產物（`dist/index.js`），不重複實作任何邏輯。
// `package.json` 的 `main`／`exports` 仍指向 `dist`，npm 套件也只帶 `dist`。
export { default } from "./dist/index.js";
