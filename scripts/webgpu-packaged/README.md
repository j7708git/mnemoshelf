# 打包版 WebGPU 冒煙

從 repo 根目錄操作；必須事先完成正式 app bundle 與前一輪已驗證的模型 cache。這些腳本不建置、不安裝、不推送、不新增依賴。一次只跑一個模型案例；每個 ID 都會建立全新目錄，禁止重用。只支援本輪 macOS arm64。啟動的是 app bundle 自己的 `Contents/MacOS/mnemoshelf`，不是另一個 Electron entry。

```sh
export PACKAGED_APP="$PWD/.tmp/webgpu-packaged/build/mac-arm64/mnemoshelf.app"
export PACKAGED_CACHE="$PWD/.tmp/webgpu-integration/cache"
PACKAGED_ID=gpu-01 PACKAGED_SCENARIO=gpu node scripts/webgpu-packaged/run.mjs
PACKAGED_ID=default-01 PACKAGED_SCENARIO=default node scripts/webgpu-packaged/run.mjs
PACKAGED_ID=budget-01 PACKAGED_SCENARIO=budget node scripts/webgpu-packaged/run.mjs
PACKAGED_ID=gui-01 PACKAGED_SCENARIO=gui node scripts/webgpu-packaged/run.mjs
```

每案複製並逐檔核對 `verified-models.json` 的 SHA-256，結束再檢查一次；獨立 userData、合成 root、隨機 token，不讀原 App 資料。此流程沒有封鎖網路；GUI 的產品 updater 可能檢查版本，但不執行下載或安裝。headless 略過 updater。`default` 會清掉繼承的所有 `MNEMOSHELF_*`，確實不設定 device；其餘案例明示 WebGPU。實際輸出在忽略的 `.tmp/webgpu-packaged/runs/<ID>`，包括 supervisor 的退出、耗時與子程序群 RSS。連線資訊含 token，不要分享該檔或 userData。headless 對 hash 驗證過的合成文字與 PNG 透過真實 REST 索引及明示向量搜尋，並查 SQLite 的 chunk／向量數及圖片 chunk；probe passed 是產品對文字與圖片探測都成功的結果。GUI 沿用產品既有 bootstrap/index 自動驗收，在真 renderer 操作並截圖，另由同一服務讀取執行裝置診斷。

`budget` 用前輪以相同模型 processor 實測為 3010 tokens 的合成查詢，斷言 CPU `token-budget` 退回與後續查詢。這裡不重新計算 tokenizer 長度，必須在驗收報告明確記錄此限制。

故障副本另外建立、修改單一 unpacked compiled embedder 的 `AutoModel.from_pretrained` device 參數：只有選定 WebGPU 時換成非法 provider，CPU 保留原值；腳本記錄前後 SHA-256，重新 ad-hoc 簽章並驗證。不得將該副本當成原始成品，也不能把此捕捉得到的失敗延伸為 native hard crash 可恢復。

```sh
PACKAGED_ID=fault-copy-01 node scripts/webgpu-packaged/fault-copy.mjs
PACKAGED_APP="$PWD/.tmp/webgpu-packaged/fault-copies/fault-copy-01/Mnemoshelf.app" PACKAGED_ID=fault-01 PACKAGED_SCENARIO=fault node scripts/webgpu-packaged/run.mjs
```

未通過、程序 crash、記憶體或時間超限均保留報告，不可覆蓋當成功案例。supervisor 每案限制 6 GiB、20 分鐘，只清理該次啟動的程序群；`sampleFailures` 非零不列為通過。執行者應檢視 GUI 截圖、打包與簽章證據，另用新 ID 執行獨立驗證。

判定器的正反向測試：`packages/core/node_modules/.bin/vitest run scripts/webgpu-packaged/assertions.test.mjs`。

以上 `run.mjs` 案例啟動參數使用 `--use-mock-keychain`，報告記為 `mock-for-isolated-smoke`。Electron 44.10.0 的 [Chromium patch](https://github.com/electron/electron/blob/v44.10.0/patches/chromium/revert_oscrypt_remove_sync_backend.patch) 在此開關下選用 FakeKeychainV2；這些案例使用隔離的假 keychain，不驗證 OS keychain 或 token 持久化。隨機 token 透過環境變數傳入。

## 真 Keychain 與跨重啟 token

此項與前面的 mock-keychain 案例獨立。從 repo 根執行 `KEYCHAIN_APP_ASAR_SHA256=<已驗證原件的64位小寫SHA256> KEYCHAIN_ID=real-01 node scripts/webgpu-packaged/keychain.mjs`；每個 ID 建立全新隔離 profile，不可續用。腳本核對任務卡指定的原 App asar 與簽章、複製並驗證模型後，直接啟動同一原件的 headless main 三次，不帶 mock 參數或 token 環境變數。每輪等待服務時每 15 秒提示；若系統出現 Keychain 授權視窗，由使用者自行操作，腳本不輸入密碼或讀取 Keychain。每次最多 20 分鐘、6 GiB，並分開記錄啟動等待時間與模型操作時間。

檢查生成後兩次讀取既有加密 token、舊 token 對新服務可授權、錯誤及缺失 token 得到 401、既有文字／圖片索引的向量搜尋與 WebGPU probe。三輪的 token 值及 token.bin 位元組只在記憶體比較，報告只寫真假，密文相等不宣稱檔案未被重寫。程序正常結束後必須自行刪除 runtime；下一次要求新的 PID 與 runtime 時間。輸出於 `.tmp/webgpu-keychain/runs/<ID>`；其中 profile 含敏感連線資訊及密文，勿分享。此流程不安裝 App、不修改產品碼或系統安全設定；測試沒有封鎖網路。
