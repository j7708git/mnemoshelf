# L2：對話迴圈 harness

假宿主（假 OpenCode `ctx`）＋真 mnemoshelf server ＋真 embedder，讓 `digest` 的完整對話迴圈
（terminal 事件 → 快照 → 回合解析 → canned 模型 → 寫入 → 召回注入）在沒有人操作的情況下跑完，
並輸出逐場景結果報告。

- 模型是假的：`ctx.generate.text()` 回傳由 fixture 決定的 canned JSON，不呼叫任何真模型、不需要 API key。
- server 與 embedder 是真的：沿用 `eval/run.mjs` 的啟動方式，使用暫存 `MNEMOSHELF_DATA_DIR`、
  隨機埠與隨機 token；embedder 模型只找現成快取，**不下載**。
- 產物：`.tmp/eval-loop/loop-report.json`、`.tmp/eval-loop/loop-report.md`（已被 gitignore）。

## 執行

```bash
pnpm --filter @mnemoshelf/opencode-plugin eval:loop
# 等價於
node packages/opencode-plugin/eval/loop.mjs
```

**pnpm 會把 `--` 原樣傳給 script**（pnpm 10 起如此），所以下面兩種寫法都支援且行為相同：

```bash
pnpm --filter @mnemoshelf/opencode-plugin eval:loop -- --fault other-location
pnpm --filter @mnemoshelf/opencode-plugin eval:loop --fault other-location
```

`parseArgs` 會忽略任何位置的 `--` 分隔符；`--fault other-location` 與
`--fault=other-location` 兩種形式也都能用。

| 參數 | 預設 | 說明 |
|---|---|---|
| `--out <dir>` | `<repo>/.tmp/eval-loop` | 報告輸出目錄 |
| `--fault <mode>` | `none` | 負向對照故障注入，見下方兩個選項 |
| `--no-build` | 關 | dist 過期／缺少時直接失敗，不自動重建 |
| `--keep` | 關 | 保留暫存資料目錄（除錯用） |
| `--verbose` | 關 | 把 server 的 stderr 也印出來 |

`--fault` 的兩個選項：

- `other-location`：讓所有一般實例的 `ctx.session.get` 回**不同**的 `location.directory`，
  digest 應該每回合以 `other-location` 跳過（writes=0、model=0）。
- `model-missing`：讓 `ctx.model.list()` 回**不含** `digestModel` 的清單，
  digest 應該每回合以 `model-unavailable` 跳過（writes=0、model=0）。

退出碼：`0`＝硬門檻全部通過；`1`＝有硬門檻失敗、未執行，或環境層失敗
（缺 embedder 模型、server 起不來、dist 過期且重建失敗）。

### dist 新鮮度

啟動前會逐檔比對 `src/**/*.ts` 與對應的 `dist/**/*.js` mtime：

- 只要有任何產物缺少或比原始檔舊，就視為 **dist 過期**，自動重建
  `@mnemoshelf/opencode-plugin`（`pnpm --filter @mnemoshelf/opencode-plugin build`），
  並印出「偵測到 dist 過期，已重建 …」。**不會**跑 `pnpm -r build`，避免動到其他在途工作。
- 重建失敗或重建後仍過期 → 直接非零退出，不測舊碼。
- 報告的 `build.rebuilt` 與 Markdown 的「dist 重建」欄位會記錄本次是否重建過。

## 場景與斷言

| 斷言 | 場景 | 類型 |
|---|---|---|
| 1 回合卡 | `a1.turn-cards-alpha`、`a1.turn-cards-chat`、`a1.snapshot-waterline` | 硬門檻 |
| 2 最近回合注入 | `a2.recent-turns-order`、`a2.greeting-not-injected` | 硬門檻 |
| 3 語意找回舊回合 | `a3.semantic-old-turn` | **僅報告（INFO）** |
| 4 scope 隔離 | `a4.alpha-not-beta`、`a4.global-visible-alpha`、`a4.alpha-not-chat` | 硬門檻 |
| 5 召回去重 TTL | `a5.dedupe-ttl` | 硬門檻 |
| 6 fail-open | `a6.fail-open-503`、`a6.fail-open-timeout` | 硬門檻 |
| 7 模型逾時 | `a7.model-timeout-before-write` | 硬門檻 |
| 8 冪等 | `a8.idempotent-success`、`a8.idempotent-empty`、`a8.idempotent-timeout`、`a8.idempotent-bad-json`、`a8.idempotent-write-failure` | 硬門檻 |
| 9 digest.log 隱私 | `a9.log-privacy` | 硬門檻 |
| 負向自我檢查 | `n1.other-location-skipped`、`n2.model-unavailable-skipped` | 硬門檻 |

**`INFO` 與 `PASS`／`FAIL` 的區別**：斷言 3 只輸出觀察值（是否靠語意找回舊回合、分數、是否注入），
不設門檻，因此報告標成 `INFO`，不影響退出碼，也不代表通過或失敗。其餘項目是硬門檻：
全部 `PASS` 才會得到退出碼 0。報告的「九條斷言」彙總表也把兩類分成不同表格。

報告另含結論指紋（逐場景狀態的 hash，**模式一併納入**）：同一模式重跑可比對是否一致，
不同 `--fault` 模式不會撞同一個指紋。

## 假宿主實例

- 共用世界：`alpha`（project，15 回合）、`beta`（project，15 回合）、
  `chat`（`openchamber/chats/<日期>/session-<uuid>`，6 回合）。
- 其餘場景各自建立獨立實例（各自一份 `ctx.storage`、訊息與 digest.log），避免去重與預算串線。
- `ctx.model.list()` 必須回一筆與 `digestModel` 完全相符的 `providerID`＋`id`，否則 digest 會在
  啟動期判定 `model-unavailable`，每一回合都跳過、一次模型都不呼叫（報告的「模型驗證」表會標示）。

## 隱私

- 報告只含場景結果、次數與原因碼；不含對話全文、prompt、金鑰或 sessionID 明文。
- `digest.log` 的隱私斷言只掃**檔案**（console log 另有明文 sessionID，刻意不掃）。
- 測試資料全部是合成內容。
