# 第三方授權與 LGPL-3.0 合規說明

Mnemoshelf 桌面版的安裝檔會隨附多個第三方套件。本檔說明其中的 **LGPL-3.0** 元件（sharp 使用的
預編 libvips）以及本專案滿足其散布義務的做法。完整的第三方清單（含版本）由每個 Release 附上的
`third-party-licenses-<平台>.txt` 提供（以 `pnpm licenses list --prod --long` 產生）。

## LGPL-3.0 元件：libvips（sharp 的影像處理後端）

Mnemoshelf 的縮圖功能使用 `sharp`。sharp 的預編產物把 **libvips** 以**動態載入的 shared library**
形式隨附；依平台不同，LGPL-3.0-or-later 的套件如下（版本隨 `sharp` 版本而變；下表為 `sharp@0.35.5`
的情形）：

| 平台 | LGPL 套件 | 授權欄位 | 隨附的 libvips 檔案 |
|---|---|---|---|
| Linux x64 | `@img/sharp-libvips-linux-x64@1.3.4` | LGPL-3.0-or-later | `lib/libvips-cpp.so.8.18.7` |
| Linux arm64 | `@img/sharp-libvips-linux-arm64@1.3.4` | LGPL-3.0-or-later | `lib/libvips-cpp.so.8.18.7` |
| macOS（Apple Silicon） | `@img/sharp-libvips-darwin-arm64@1.3.4` | LGPL-3.0-or-later | `lib/libvips-cpp.8.18.7.dylib` |
| Windows x64 | `@img/sharp-win32-x64@0.35.5` | `Apache-2.0 AND LGPL-3.0-or-later` | `lib/libvips-42.dll`、`lib/libvips-cpp-8.18.7.dll` |

（Linux／macOS 的 libvips 是獨立平台套件；Windows 則把 libvips 的 DLL 打包進 sharp 的平台套件，
因此該套件的授權欄位同時含 Apache-2.0 與 LGPL-3.0-or-later。`sharp` 本體與 Linux／macOS 的
`@img/sharp-<平台>` 為 Apache-2.0。）

> 本專案不修改 libvips；上述檔案是上游（sharp／sharp-libvips 專案）的預編產物原樣隨附。

## 本專案如何滿足 LGPL-3.0 的散布要求

1. **附上授權全文。** 本目錄的 [`LGPL-3.0.txt`](LGPL-3.0.txt) 與 [`GPL-3.0.txt`](GPL-3.0.txt)
   （LGPL-3.0 是「附加在 GPL-3.0 之上」的授權，兩份全文一併提供）。每個 GitHub Release 也一併附上。
2. **提供對應原始碼的取得方式。**
   - 預編 libvips 的建置專案：<https://github.com/lovell/sharp-libvips>
     - Linux／macOS 的 `@img/sharp-libvips-<平台>` 版本 **1.3.4** 對應 tag
       [`v1.3.4`](https://github.com/lovell/sharp-libvips/tree/v1.3.4)（該版本 npm 套件的
       `gitHead` 為 `ebb95f8add54eee8bed840e3fb587e4cbec857d7`）。
     - Windows 的 libvips 隨 `@img/sharp-win32-x64` 發佈，來源是 sharp 專案
       （<https://github.com/lovell/sharp>，版本 0.35.5 的 `gitHead` 為
       `51a990faa26ade5586a4934ac9673c98d8893326`）。
     - 各平台目錄（例如 `npm/linux-x64/`）內的 `versions.json` 列出所打包的每個相依元件版本
       （本產物所用 libvips 為 **8.18.7**）。
   - libvips 本體：<https://github.com/libvips/libvips>（取得 `versions.json` 中 `vips` 欄位所指的版本）。
   - 也可直接取得實際隨附的 npm 套件內容：`npm pack @img/sharp-libvips-<平台>@<版本>`。
3. **可替換該 shared library。** libvips 不是與應用程式靜態連結成單一程式，而是執行期動態載入的
   共用程式庫。安裝後的檔案位於應用程式資源目錄
   `resources/app.asar.unpacked/node_modules/@img/.../lib/`（Linux／macOS）或
   `resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/`（Windows）；
   使用者可以自行建置的**介面相容**版本直接取代該檔案，應用程式即可改用被修改過的 libvips。

> 以上為工程層面的合規做法整理，不構成法律意見。若需要更正式的書面要約或其他安排，請提出。

## 其他主要第三方套件（授權摘要）

| 套件 | 授權 |
|---|---|
| Electron | MIT |
| better-sqlite3 | MIT |
| sqlite-vec（含 `sqlite-vec-<平台>`） | MIT OR Apache-2.0 |
| onnxruntime-node | MIT |
| `@huggingface/transformers` | Apache-2.0 |
| sharp、`@img/sharp-<平台>` | Apache-2.0 |
| `@img/sharp-libvips-<平台>` | LGPL-3.0-or-later |

其餘套件見 Release 附件 `third-party-licenses-<平台>.txt`。
