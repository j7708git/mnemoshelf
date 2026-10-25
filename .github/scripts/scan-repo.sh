#!/usr/bin/env bash
# 隱私掃描入口：密鑰（gitleaks）＋ 個人本機絕對路徑（Python）。
#
# 設計原則：
# - 規則唯一來源：密鑰與白名單在 `.gitleaks.toml`，個人本機路徑在
#   `.github/repo-privacy-policy.json`（與本機 commit／push 前的隱私檢查同一份政策）。
#   這支腳本不另外維護規則。
# - 只掃「會進版控的檔案」：`git ls-files --cached --others --exclude-standard`。
#   被忽略的生成物（node_modules、dist、dist-app…）不會被掃；`pnpm-lock.yaml`
#   是已追蹤檔案，照樣會掃。
# - 輸出不得印出機密原文：gitleaks 一律 `--redact`，而且這裡只解析 JSON 報告印出
#   `檔案:行號` 與規則名稱；個人路徑只印位置，不印命中的路徑。
# - 退出碼：0 = 乾淨、1 = 有發現、2 = 工具或設定錯誤（掃描沒有完成，不等於乾淨）。
#
# 在 CI 由 `.github/workflows/privacy-scan.yml` 呼叫；本機可直接執行：
#   bash .github/scripts/scan-repo.sh
set -uo pipefail

# 與 CI 下載的版本一致；不同版本的內建規則可能不同，所以要求同一版。
REQUIRED_GITLEAKS_VERSION="8.30.1"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 2
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)" || exit 2
cd "$REPO_ROOT" || exit 2

fail() {
  echo "錯誤：$*" >&2
  exit 2
}

# ---- 前置檢查：工具不在就明確說「掃描沒有完成」，不要讓 2 被誤讀成「有發現」 ----

if ! command -v gitleaks >/dev/null 2>&1; then
  cat >&2 <<'MSG'
錯誤：找不到 gitleaks，掃描沒有完成（這不是「乾淨」）。
本掃描釘住 gitleaks 8.30.1；CI 會從官方 release 下載並驗 checksum，本機請自行安裝：
  官方 release：https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1
  把 gitleaks 執行檔放進 PATH 上的目錄即可（例如使用者自己的 bin 目錄，不需放進 repo）。
這支腳本不會自行下載執行檔。
MSG
  exit 2
fi

GITLEAKS_VERSION="$(gitleaks version 2>/dev/null | tr -d '[:space:]')"
if [ "$GITLEAKS_VERSION" != "$REQUIRED_GITLEAKS_VERSION" ]; then
  fail "gitleaks 版本是 ${GITLEAKS_VERSION:-未知}，本掃描釘住 ${REQUIRED_GITLEAKS_VERSION}；請換成同一版本再跑（避免規則差異造成不同結果）。"
fi

if ! command -v python3 >/dev/null 2>&1; then
  fail "找不到 python3；個人本機路徑檢查需要 Python 3（只用標準函式庫）。"
fi

# ---- 準備：把待掃檔案匯出到暫存目錄 ----

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mnemoshelf-privacy-scan.XXXXXX")" || fail "無法建立暫存目錄。"
cleanup() { rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT INT TERM

FILE_LIST="$TMP_DIR/file-list"
SCAN_TREE="$TMP_DIR/tree"
mkdir -p "$SCAN_TREE" || fail "無法建立暫存目錄 $SCAN_TREE。"

# `--cached --others --exclude-standard`＝已追蹤 ＋ 未追蹤但未被忽略的檔案。
# 後者讓「還沒 commit 的新檔」在本機也會被掃到；已忽略的生成物則不會。
if ! git ls-files -z --cached --others --exclude-standard > "$FILE_LIST"; then
  fail "git ls-files 失敗；請在 repo 內執行（或確認 git 可用）。"
fi

# 先複製再掃：`gitleaks dir` 不讀 .gitignore，直接掃工作目錄會把 node_modules 與
# 打包產物一起掃進去（本機 node_modules 超過 1 GB），未追蹤的暫存檔也會被掃。
# 匯出的清單已排除被忽略的路徑；`pnpm-lock.yaml` 是已追蹤檔案，仍會被掃。
if ! tar --null -T "$FILE_LIST" -cf - 2>/dev/null | tar -xf - -C "$SCAN_TREE" 2>/dev/null; then
  fail "匯出待掃檔案到暫存目錄失敗（掃描期間有檔案被刪除或移動？）。"
fi

# gitleaks 的預設設定（本 repo 用 `useDefault = true` 沿用）把 `pnpm-lock.yaml` 放進
# 全域白名單——它假設 lockfile 只有相依解析結果。但 registry token 可能出現在
# lockfile，本專案要求一定要掃它；因此在「暫存副本」改名，繞過那條依檔名的白名單，
# 報告輸出再映射回原名。不在 `.gitleaks.toml` 複製整份預設規則，避免規則漂移。
LOCKFILE_NAME="pnpm-lock.yaml"
if [ -f "$SCAN_TREE/$LOCKFILE_NAME" ]; then
  mv "$SCAN_TREE/$LOCKFILE_NAME" "$SCAN_TREE/$LOCKFILE_NAME.scan" \
    || fail "無法為 pnpm-lock.yaml 建立待掃副本。"
fi

# ---- 一、密鑰掃描（gitleaks） ----

echo "== 1/2 密鑰掃描（gitleaks ${GITLEAKS_VERSION}）=="

REPORT="$TMP_DIR/gitleaks-report.json"
if gitleaks dir \
  --config "$REPO_ROOT/.gitleaks.toml" \
  --redact \
  --no-banner \
  --no-color \
  --log-level warn \
  --report-format json \
  --report-path "$REPORT" \
  "$SCAN_TREE"; then
  GL_RC=0
else
  GL_RC=$?
fi

if [ "$GL_RC" -ne 0 ] && [ "$GL_RC" -ne 1 ]; then
  fail "gitleaks 執行失敗（退出碼 ${GL_RC}）。"
fi

# 只解析 JSON 報告：連 gitleaks 的預設文字輸出都不用，確保不會有機會印出機密原文。
cat > "$TMP_DIR/parse-gitleaks.py" <<'PY'
"""把 gitleaks 的 JSON 報告轉成「檔案:行號 規則名稱」，不輸出任何機密內容。"""
import json
import sys

report_path, source = sys.argv[1], sys.argv[2].replace("\\", "/").rstrip("/") + "/"
try:
    with open(report_path, encoding="utf-8") as handle:
        findings = json.load(handle)
except (OSError, ValueError) as exc:
    print(f"無法讀取 gitleaks 報告：{exc}", file=sys.stderr)
    sys.exit(2)

if not isinstance(findings, list):
    print("gitleaks 報告格式不是陣列。", file=sys.stderr)
    sys.exit(2)

# 固定輸出順序，讓本機與 CI 的 log 可直接對照。
findings.sort(key=lambda item: (str(item.get("File") or ""), item.get("StartLine") or 0))

for finding in findings:
    path = str(finding.get("File") or "?").replace("\\", "/")
    if path.startswith(source):
        path = path[len(source):]
    # scan-repo.sh 為了避開 gitleaks 預設的 lockfile 白名單，把 pnpm-lock.yaml
    # 改名成 pnpm-lock.yaml.scan；報告要映射回 repo 裡的實際檔名。
    if path.endswith("pnpm-lock.yaml.scan"):
        path = path[: -len(".scan")]
    line = finding.get("StartLine") or "?"
    rule = finding.get("RuleID") or "unknown"
    print(f"{path}:{line}: secret:{rule}")
PY

SECRET_FINDINGS="$TMP_DIR/secret-findings.txt"
if ! python3 "$TMP_DIR/parse-gitleaks.py" "$REPORT" "$SCAN_TREE" > "$SECRET_FINDINGS"; then
  fail "解析 gitleaks 報告失敗，掃描沒有完成。"
fi

LEAK_COUNT="$(wc -l < "$SECRET_FINDINGS" | tr -d '[:space:]')"
LEAK_COUNT="${LEAK_COUNT:-0}"

if [ "$GL_RC" -eq 1 ] && [ "$LEAK_COUNT" -eq 0 ]; then
  fail "gitleaks 回報有發現，但 JSON 報告是空的；掃描沒有完成。"
fi

if [ "$LEAK_COUNT" -gt 0 ]; then
  echo "密鑰：發現 ${LEAK_COUNT} 處"
  cat "$SECRET_FINDINGS"
else
  echo "密鑰：0 處"
fi

# ---- 二、個人本機絕對路徑（Python，讀同一份政策 JSON） ----

echo "== 2/2 個人本機路徑掃描 =="

PATH_RC=0
python3 "$REPO_ROOT/.github/scripts/check-personal-paths.py" --root "$REPO_ROOT" || PATH_RC=$?

case "$PATH_RC" in
  0 | 1) ;;
  *) fail "個人本機路徑檢查沒有完成（退出碼 ${PATH_RC}）。" ;;
esac

# ---- 結果 ----

if [ "$LEAK_COUNT" -gt 0 ] || [ "$PATH_RC" -eq 1 ]; then
  echo "隱私掃描：發現問題（密鑰 ${LEAK_COUNT} 處；個人本機路徑見上）。" >&2
  exit 1
fi

echo "隱私掃描：通過（密鑰 0 處；個人本機路徑 0 處）。"
exit 0
