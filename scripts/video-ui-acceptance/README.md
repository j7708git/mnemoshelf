# 產品 UI 驗收 runner

以隔離的合成 root、瀏覽器 profile／desktop userData 操作產品 DOM。需先完成產品 build，並在 PM 安排的真模型時段執行；此 runner 不建置，啟動前檢查文字、視覺及音訊 q4 模型必要檔並複製／連結至隔離快取；若其他資產缺少，產品本身仍可能嘗試下載。使用 Node 22 以上與本機 CDP WebSocket，不引入套件。

執行前設定 `MNEMOSHELF_MODEL_DIR` 指向已存在的模型快取；standalone 另設定 `MNEMOSHELF_FFMPEG_PATH` 與 `MNEMOSHELF_FFPROBE_PATH`。以 `MNEMOSHELF_UI_SYNTHETIC_ROOT` 指定下方重建的合成 root；舊版相容預設為 `.tmp/video-d2/root-mixed`。runner 每次只修改複製到專屬 `.tmp` run 的素材，不改來源。packaged 預設使用 `packages/desktop/dist-app/win-unpacked/mnemoshelf.exe`，可用 `MNEMOSHELF_UI_PACKAGED` 覆寫。Chrome 預設使用 Program Files 位置，可用 `MNEMOSHELF_UI_CHROME` 覆寫。

```powershell
node scripts/video-ui-acceptance/run.mjs standalone
$env:VIDEO_UI_BUILD_MANIFEST = '.tmp/video-acceptance/builds/<build-id>/manifest.json'
node scripts/video-ui-acceptance/run.mjs packaged
```

每次在 `.tmp/video-ui-acceptance/` 建新 run，寫 report、各步驟 DOM 與截圖；token 不寫入報告或網址。需實際啟動服務、模型及 decoder，執行時間依機器而異。報告的 `uiFlowPassed` 與 `normalShutdown` 分開，兩者皆成立才是 `ok`；standalone 使用隔離 headless Chrome 與 CDP Browser.close；packaged 會顯示獨立 userData 的測試視窗，並透過 Node inspector 觸發產品既有 SIGTERM 清理路徑，要求正常退出及對應日誌。未正常退出會記為失敗並清理自有程序樹，不能把強制清理算成正常關閉。這是 CDP 驅動的真產品 UI，不是人工操作證據；搜尋結果排名與樣本內容會影響案例，失敗須保留 report 與截圖供分析。尚未經執行驗證時不應視為驗收通過。

瀏覽器網路觀測檢查播放 Range 206、關閉預覽後原 session 401，以及 CDP 啟用後觀測的 URL 不含 token 或 URL 編碼 token；不聲稱實際等待完整 15 分鐘到期。

## 重建 D2 合成混合 root

此流程不需要保留 `.tmp/video-d2/root-mixed`。先準備完全符合 `scripts/video-acceptance/queries-frozen-v1.json` 的 eval-root，以及 A2 原始 `tts/t01.wav`。既有合成來源可直接使用；若沒有，以下在獨占 FFmpeg 時段產生全新 corpus。Windows 必須安裝腳本指定的 SAPI 聲音與 FFmpeg 的 `libopenh264`，並設定 `MNEMOSHELF_FFMPEG`／`MNEMOSHELF_FFPROBE` 指向候選 binary。TTS／編碼結果會因聲音、版本或平台不同而改變，重生**不保證**符合凍結 hash；不符即停止，不可更改 frozen labels 或用不同聲音冒稱原素材。

```powershell
# corpus ID 必須新且只含英數、底線、連字號；每次使用獨立 ID。
$env:VIDEO_CORPUS_RUN_ID = 'ui-corpus-unique'
pwsh -NoProfile -File scripts/video-acceptance/corpus/tts.ps1
node scripts/video-acceptance/corpus/generate-quality.mjs
node scripts/video-acceptance/corpus/verify-corpus.mjs
node scripts/video-acceptance/corpus/assemble-frozen-eval.mjs

# 也可直接指定任何已保留、hash 符合的 A2 eval-root 與 t01.wav。
$corpus = Join-Path '.tmp/video-acceptance/corpus' $env:VIDEO_CORPUS_RUN_ID
$env:VIDEO_UI_EVAL_ROOT = Join-Path $corpus 'eval-root'
$env:VIDEO_UI_TTS_FILE = Join-Path $corpus 'tts/t01.wav'
$env:VIDEO_UI_FIXTURE_ID = 'ui-fixture-unique'
node scripts/video-ui-acceptance/prepare-fixtures.mjs
$env:MNEMOSHELF_UI_SYNTHETIC_ROOT = Join-Path '.tmp/video-ui-acceptance/fixtures' (Join-Path $env:VIDEO_UI_FIXTURE_ID 'root')
node scripts/video-ui-acceptance/run.mjs standalone
```

`prepare-fixtures.mjs` 本身不呼叫 FFmpeg、不載模型；先驗 frozen labels 及四支 MP4 hash，再驗 t01 原始 WAV hash、複製後重新驗證。它在 `.tmp/video-ui-acceptance/fixtures/<id>` 建新 root 與 root 外 manifest，同名目錄拒絕重用、不覆寫來源。TTS 的原始來源規則是 A2 的 Windows SAPI `Microsoft Hanhan Desktop`、16 kHz PCM16 mono、自撰台詞；必須符合原始 WAV SHA-256。文字精確重建 D2 位元組並核對 hash。

D2 `starry-circle.png` 實際是 320×200 合成漸層與圓形，**不是影片截幀，沒有影格時間**。原產生腳本未找到；新版依原檔 RGB 值重建，核對全圖 RGB SHA-256，PNG 編碼 bytes 可不同。此圖、文字和音訊用於 UI 四模態驗收；未修改任何凍結問題或影片。

packaged 模式必須指定 repo 內相對的 `VIDEO_UI_BUILD_MANIFEST`；啟動前實際重算 ASAR、FFmpeg、ffprobe hash 並核對 manifest，報告保存 manifest／runner hash、產物 hash 與索引後 `diagnostics.embedderRuntime`，並要求模型已載入 CPU。runner 開始及結束 hash 不同則不通過。manifest 由獨立 build 證據工具產生；此檢查不取代其 source／dist 核對。
