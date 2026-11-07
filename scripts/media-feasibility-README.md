# 合成音訊／影片推論探測

這組獨立腳本驗證已安裝的 Transformers.js 4.3.1、EmbeddingGemma 2 q4，在 Node 與 Electron 44.10.0 能否接受 PCM／影像幀並產生有效向量。它不是檔案格式解碼器，也不會開啟正式 App 或真實資料庫。

所有輸入都由腳本建立：16 kHz mono 的 440 Hz 正弦波，以及四張 64×64 RGB 圖案；不需要私人文件、錄音或影片。推論結果和下載只放 `.tmp/media-feasibility/`，不修改 package manifest。

## 先決條件

- 從 repo 根執行，現有 workspace 依賴已安裝；本輪使用 Node 24.13.0 與 pnpm。
- 已有公開模型 `onnx-community/embeddinggemma-2-ONNX` 的文字／視覺 q4 快取：config、processor、tokenizer 以及 `model_q4.onnx`／`.onnx_data`、`vision_encoder_q4.onnx`／`.onnx_data`。它們是公開模型資產，不是使用者資料。
- 預設讀取應用程式模型快取；可用 `MNEMOSHELF_MODEL_DIR` 指定其他快取根（其下包含 `onnx-community` 目錄）。若沒有這些資產，先依專案正常模型下載流程取得，或從[固定官方 revision](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/tree/daa72c51243991dfcaf9f9137d2c573d8f7790c0)取得相同檔案；preparer 不會替缺少的文字／視覺資產下載其他模型。

## Node：完整音訊與影片推論

以下 preparer 明確下載 **189,321,511 bytes** 的音訊 q4 資產，固定 revision 並檢查 SHA256；也把現有文字／視覺快取複製到 `.tmp`，保留來源不變。已備好隔離快取時可以略過 preparer，避免重複下載。

```powershell
node scripts/media-feasibility-prepare.ts
$env:MNEMOSHELF_MODEL_DIR = Join-Path (Get-Location) '.tmp/media-feasibility/models'
node scripts/media-feasibility.ts
```

Runner 禁止遠端模型下載。若只有原始文字／視覺快取，可直接執行 runner，報告會標示音訊 encoder 缺失；那不是完整音訊推論通過。完整測試應確認 `audioInference.status` 為 `passed`。

## Electron 44.10.0：獨立 main process

這個 Windows x64 範例下載官方 ZIP（157,979,095 bytes），比對同 release 的 SHASUMS256，再解包至 `.tmp`；不觸發 npm Electron 入口的隱含下載。已有執行檔時可略過下載，設定 `MEDIA_ELECTRON_PATH` 指向其位置，報告會記錄實際版本。

```powershell
@'
import { join } from 'node:path';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const output = join(process.cwd(), '.tmp', 'media-feasibility');
await mkdir(output, { recursive: true });
const base = 'https://github.com/electron/electron/releases/download/v44.10.0/';
const name = 'electron-v44.10.0-win32-x64.zip';
const checksumResponse = await fetch(base + 'SHASUMS256.txt');
assert(checksumResponse.ok);
const expected = (await checksumResponse.text()).split('\n')
  .find(line => line.trim().endsWith(name))?.trim().split(/\s+/)[0];
assert(expected);
const response = await fetch(base + name);
assert(response.ok && response.body);
const destination = join(output, name);
await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
const hash = createHash('sha256');
for await (const chunk of createReadStream(destination)) hash.update(chunk);
assert.equal(hash.digest('hex'), expected);
console.log('Electron ZIP checksum verified');
'@ | node --input-type=module

# 解包只需執行一次；目錄已存在且正確時略過。
$archive = Join-Path (Get-Location) '.tmp/media-feasibility/electron-v44.10.0-win32-x64.zip'
Expand-Archive -LiteralPath $archive -DestinationPath .tmp/media-feasibility/electron-44.10.0
$env:MNEMOSHELF_MODEL_DIR = Join-Path (Get-Location) '.tmp/media-feasibility/models'
node scripts/media-feasibility-electron.ts
```

Launcher 不開視窗，使用獨立 userData，正常完成後先釋放模型再退出；沒有硬殺 timeout。ESM 入口用 `app.whenReady().then(...)`，避免頂層等待 ready 造成啟動互等。若受限執行環境回報 AppContainer ACL fatal，需在已授權的原生執行環境測試；不要關閉 Electron sandbox 或修改正式 App 設定來繞過。

## 判讀與檢查

輸出是 `node-report.json`／`electron-report.json`，下載資訊是 `download-report.json`。主要檢查：

- 音訊 1 秒／10 秒、影片四幀的模型輸出都為 768 維、finite，L2 模長誤差小於 0.001。
- `audio31Equals30: true` 表示成功重現上游 30 秒靜默截短，產品必須先切片；不是長音訊驗收通過。
- `timestampVectorExactlyEqual: true` 表示改時間戳不改向量，原片定位需由應用保存。
- 40 幀輸入的抽樣 helper 只留 32 幀；本輪沒有執行 32 幀的大型推論。
- `loadAudio`／`loadVideo` 的拒絕訊息是預期證據：Node／Electron main process 沒有這些 browser 解碼入口。PCM 與 RawVideo 推論成功不代表 WAV、MP3、MP4 檔案解碼成功。

型別檢查不需新增套件：

```powershell
pnpm --filter @mnemoshelf/embedder-transformers exec tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck ../../scripts/media-feasibility.ts ../../scripts/media-feasibility-prepare.ts ../../scripts/media-feasibility-electron.ts
```

測完關閉這個 shell，或移除本次設定的模型／Electron 環境變數；不要把研究快取設定帶進正式服務。這些結果只證明本輪 Windows CPU runtime 的推論可行，不涵蓋 packaged App、DML、其他平台或檢索品質。
