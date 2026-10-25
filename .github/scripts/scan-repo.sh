#!/usr/bin/env bash
# 隱私掃描入口：密鑰（gitleaks）＋ 個人本機絕對路徑（Python）。
#
# 設計原則：
# - 規則來源：**這個 repo 以 `.github/repo-privacy-policy.json`（個人路徑）與
#   `.gitleaks.toml`（密鑰）為準**。工作區層級另有一份 `.openchamber/repo-privacy-policy.json`
#   給其他專案的本機 hook 使用；兩份內容目前相同，但各自獨立、沒有同步機制——改規則時
#   兩邊都要改。這支腳本不另外維護規則。
# - 掃描兩種範圍，輸出會標明是「樹掃描」「範圍掃描」或「兩者都做」：
#   1. 工作樹：`git ls-files --cached --others --exclude-standard`（已追蹤 ＋ 未追蹤但未被
#      忽略的檔案）。判準是「會不會進版控」，不是目錄名稱——`git add -f` 加進來的
#      `out/`、`dist/` 檔案照樣會掃。
#   2. 提交範圍：push 是 `before..after`（`before` 全零時退回「上一個版本 tag..head」），
#      pull request 是「合併基底..PR head」。用來抓「同一批 push 裡先加後刪」的內容——
#      那些內容在工作樹已經看不到，但確實被推上去過。
# - 輸出不得印出機密原文：gitleaks 一律 `--redact`，而且這裡只解析 JSON 報告印出
#   `檔案:行號` 與規則名稱；個人路徑只印位置，不印命中的路徑。
# - 關掉自我排除的後門：呼叫 gitleaks 一律帶 `--ignore-gitleaks-allow`，並用
#   `--gitleaks-ignore-path` 指向一個沒有 `.gitleaksignore` 的暫存目錄；匯出後把
#   `.gitleaksignore` 從暫存樹移除，範圍掃描則在「沒有 checkout、因此沒有
#   `.gitleaksignore`」的暫存 clone 上跑。repo 內的忽略檔或行內 `# gitleaks:allow`
#   不能讓發現消失。
# - 退出碼：0 = 乾淨、1 = 有發現、2 = 掃描沒有完成（工具或設定錯誤、有檔案被跳過）。
#
# 在 CI 由 `.github/workflows/privacy-scan.yml` 呼叫；本機可直接執行：
#   bash .github/scripts/scan-repo.sh
#   bash .github/scripts/scan-repo.sh --self-test   # 在暫存目錄建合成樣本自我測試
#
# 這是**事後偵測**，不是推送當下的阻擋；也不涵蓋更早的歷史 commit、force push 覆寫掉的
# 中間 commit、commit message／PR 描述、GitHub 以外的備份。支援 Linux／macOS，以及 Windows
# 的 Git Bash／WSL（原生 PowerShell 不支援）。
set -uo pipefail

# 與 CI 下載的版本一致；不同版本的內建規則可能不同，所以要求同一版。
REQUIRED_GITLEAKS_VERSION="8.30.1"

# gitleaks 預設設定把這些 lockfile 依「檔名」放進全域白名單。lockfile 可能夾帶 registry
# token，所以掃描前在暫存副本改名，報告再映射回原名。
LOCKFILE_NAMES=(pnpm-lock.yaml package-lock.json yarn.lock deno.lock npm-shrinkwrap.json)

SELF_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/$(basename -- "${BASH_SOURCE[0]}")" || exit 2
SCRIPT_DIR="$(dirname -- "$SELF_PATH")" || exit 2
TOOL_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)" || exit 2
CONFIG_FILE="$TOOL_ROOT/.gitleaks.toml"
POLICY_FILE="$TOOL_ROOT/.github/repo-privacy-policy.json"
CHECKER="$SCRIPT_DIR/check-personal-paths.py"
PYTHON="${PYTHON:-python3}"

SCAN_ROOT="$TOOL_ROOT"
SELF_TEST=0

fail() {
  echo "錯誤：$*" >&2
  exit 2
}

usage() {
  cat <<'MSG'
用法：bash .github/scripts/scan-repo.sh [--self-test] [--root <dir>]

  --self-test   在暫存目錄建立合成樣本（假 token、假個人路徑、UTF-16、含 NUL、>4MB、
                tracked out/、.gitleaksignore、行內 gitleaks:allow、lockfile）並驗證
                scanner 真的抓得到、乾淨樣本真的過、白名單樣本真的不報。
  --root <dir>  掃描指定的 repo 根（主要給自我測試用；規則仍取自本腳本所在的 repo）。

退出碼：0 乾淨、1 有發現、2 掃描沒有完成（不等於乾淨）。
MSG
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --self-test)
      SELF_TEST=1
      shift
      ;;
    --root)
      [ "$#" -ge 2 ] || fail "--root 需要一個目錄參數。"
      SCAN_ROOT="$(cd -- "$2" && pwd -P)" || fail "--root 不是可存取的目錄：$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "未知參數：$1"
      ;;
  esac
done

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

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  fail "找不到 ${PYTHON}；個人本機路徑檢查需要 Python 3（可用環境變數 PYTHON 指定解譯器）。"
fi

if ! command -v git >/dev/null 2>&1; then
  fail "找不到 git；掃描需要 git（列出待掃檔案與取得提交範圍）。"
fi

# ---- 共用：判斷提交是否存在、解析 gitleaks 報告 ----

commit_exists() {
  [ -n "${1:-}" ] && git -C "$SCAN_ROOT" rev-parse --verify --quiet "$1^{commit}" >/dev/null 2>&1
}

is_zero_sha() {
  case "${1:-}" in
    "" | 0000000000000000000000000000000000000000) return 0 ;;
    *) return 1 ;;
  esac
}

# 把 gitleaks 的 JSON 報告轉成「檔案:行號」與「規則名」兩段，不輸出任何機密內容。
# （說明文字刻意避開「關鍵字＋冒號＋長文字」的樣子：那會被憑據賦值的規則誤判成密鑰。）
write_report_parser() {
  cat > "$TMP_DIR/parse-gitleaks.py" <<'PY'
"""把 gitleaks 的 JSON 報告轉成「檔案:行號 規則名稱」，不輸出任何機密內容。"""
import json
import sys

report_path = sys.argv[1]
source = sys.argv[2].replace("\\", "/").rstrip("/")
prefix = source + "/" if source else ""
renamed = set(sys.argv[3].split()) if len(sys.argv) > 3 else set()

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
    if prefix and path.startswith(prefix):
        path = path[len(prefix):]
    # 為了避開 gitleaks 預設的 lockfile 白名單，暫存副本把 lockfile 改名成 <name>.scan；
    # 報告要映射回 repo 裡的實際檔名。
    base = path.rsplit("/", 1)[-1]
    if base.endswith(".scan") and base[: -len(".scan")] in renamed:
        path = path[: -len(".scan")]
    line = finding.get("StartLine") or "?"
    rule = finding.get("RuleID") or "unknown"
    print(f"{path}:{line}: secret:{rule}")
PY
}

# gitleaks 以 0（乾淨）／1（有發現）表示正常結束；其他退出碼代表工具失敗。
# `--log-level error` 下 stderr 有任何 ERR 也代表掃描沒有完成（gitleaks 曾對無效的
# git 範圍只記 ERR 卻以 0 結束，不能只看退出碼）。
check_gitleaks_result() {
  local rc="$1" err_file="$2" what="$3"
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; then
    fail "gitleaks ${what}失敗（退出碼 ${rc}）。"
  fi
  if [ -s "$err_file" ] && grep -q 'ERR' "$err_file"; then
    echo "--- gitleaks ${what} stderr ---" >&2
    sed -n '1,20p' "$err_file" >&2
    fail "gitleaks ${what}回報錯誤，掃描沒有完成。"
  fi
}

parse_report() { # <report> <source-prefix> <output>
  local report="$1" source="$2" output="$3"
  "$PYTHON" "$TMP_DIR/parse-gitleaks.py" "$report" "$source" "${LOCKFILE_NAMES[*]}" \
    > "$output.unsorted" || fail "解析 gitleaks 報告失敗，掃描沒有完成。"
  # 同一位置在多個 commit 重複出現時只留一筆，輸出順序固定。
  sort -u "$output.unsorted" > "$output" || fail "整理 gitleaks 報告失敗。"
}

# ---- 自我測試：在暫存目錄建合成樣本，證明 scanner 不是 no-op ----

self_test() {
  local st_root
  st_root="$(mktemp -d "${TMPDIR:-/tmp}/mnemoshelf-scan-self-test.XXXXXX")" \
    || fail "無法建立自我測試暫存目錄。"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$st_root'" EXIT INT TERM

  local failures=0
  local SCAN_RC=0

  # 合成值在執行時才組出來：repo 內不留「像密鑰／像個人路徑」的靜態字串，
  # 否則 scanner 會掃到自己的測試樣本。值本身明顯不可能被誤用。
  local fake_token fake_home fake_path
  fake_token="ghp_$(printf '%s' 'ExampleNotReal0A1b2C3d4E5f6' 'G7h8I9j0K')"
  fake_home="/home/$(printf '%s' 'not-an-allowed' '-account-example')"
  fake_path="${fake_home}/sample"

  st_ok() { echo "  通過：$*"; }
  st_fail() {
    echo "  失敗：$*" >&2
    failures=$((failures + 1))
  }

  make_repo() {
    local dir="$1"
    mkdir -p "$dir" || fail "自我測試：無法建立 $dir。"
    git -C "$dir" init -q || fail "自我測試：git init 失敗。"
    git -C "$dir" config user.name self-test
    git -C "$dir" config user.email self-test@example.invalid
    git -C "$dir" config commit.gpgsign false
    git -C "$dir" config tag.gpgsign false
  }

  commit_all() {
    local dir="$1" message="$2"
    git -C "$dir" add -A || fail "自我測試：git add 失敗。"
    git -C "$dir" commit -q -m "$message" || fail "自我測試：git commit 失敗。"
  }

  # 清除 CI 事件變數後執行指定情境；額外的 KEY=VALUE 由呼叫端以 env 傳入。
  run_scan() {
    local repo="$1" log="$2"
    shift 2
    env -u SCAN_EVENT_NAME -u SCAN_EVENT_BEFORE -u SCAN_EVENT_AFTER \
      -u GITHUB_BASE_REF -u SCAN_PR_BASE_SHA -u SCAN_PR_HEAD_SHA \
      "$@" bash "$SELF_PATH" --root "$repo" > "$log" 2>&1
    SCAN_RC=$?
  }

  expect_rc() { # <預期> <說明>
    if [ "$SCAN_RC" -eq "$1" ]; then
      st_ok "$2（退出碼 $1）"
    else
      st_fail "$2：退出碼 $SCAN_RC，預期 $1"
    fi
  }

  expect_contains() { # <log> <字串> <說明>
    if grep -Fq -- "$2" "$1"; then
      st_ok "$3"
    else
      st_fail "$3：輸出缺少 «$2»"
    fi
  }

  expect_missing() { # <log> <字串> <說明>
    if grep -Fq -- "$2" "$1"; then
      st_fail "$3：輸出不該出現 «$2»"
    else
      st_ok "$3"
    fi
  }

  dump_log() { # <log>
    echo "--- 該情境的完整輸出（$1）---" >&2
    sed -n '1,200p' "$1" >&2
  }

  # ---- 情境一：負向樣本（全部都要被抓到） ----
  echo "自我測試：情境一（負向樣本）"
  local case1="$st_root/negative"
  local log1="$st_root/negative.log"
  make_repo "$case1"
  printf 'out/\n' > "$case1/.gitignore"
  printf 'value = "%s"\n' "$fake_token" > "$case1/token.txt"
  printf 'root = "%s"\n' "$fake_path" > "$case1/personal.txt"
  printf 'value = "%s" # gitleaks:allow\n' "$fake_token" > "$case1/inline-allow.txt"
  printf 'token.txt:github-pat:1\n' > "$case1/.gitleaksignore"
  # 被追蹤的生成物目錄：舊版會因為目錄名稱 out/ 而跳過。
  mkdir -p "$case1/out"
  printf 'value = "%s"\n' "$fake_token" > "$case1/out/config.js"
  printf 'root = "%s"\n' "$fake_path" > "$case1/out/x.txt"
  printf 'export const answer = 42;\n' > "$case1/clean.js"
  printf 'a = "/home/synthetic-user/demo"\nb = "https://example.com/home/post/"\n' \
    > "$case1/allowlisted.txt"
  for name in "${LOCKFILE_NAMES[@]}"; do
    printf '{"token": "%s"}\n' "$fake_token" > "$case1/$name"
  done

  # UTF-16LE／UTF-16BE、含 NUL、以及 > maxFileBytes（單一超大行）的樣本。
  "$PYTHON" - "$case1" "$fake_path" <<'PY'
import sys

root, path = sys.argv[1], sys.argv[2]
text = f'root = "{path}"\n'
with open(f"{root}/utf16le.txt", "wb") as handle:
    handle.write(b"\xff\xfe" + text.encode("utf-16-le"))
with open(f"{root}/utf16be.txt", "wb") as handle:
    handle.write(b"\xfe\xff" + text.encode("utf-16-be"))
with open(f"{root}/nul.txt", "wb") as handle:
    handle.write(b"\x00prefix " + path.encode("utf-8") + b"\n")
with open(f"{root}/invalid-utf8.txt", "wb") as handle:
    handle.write(b"\x80\x81 prefix " + path.encode("utf-8") + b"\n")
with open(f"{root}/large.txt", "wb") as handle:
    handle.write(b"A" * (4 * 1024 * 1024 + 4096) + b" " + path.encode("utf-8") + b"\n")
PY

  git -C "$case1" add -A || fail "自我測試：git add 失敗。"
  git -C "$case1" add -f out/config.js out/x.txt || fail "自我測試：git add -f 失敗。"
  git -C "$case1" commit -q -m "synthetic negative samples" \
    || fail "自我測試：git commit 失敗。"

  local failures_before=$failures
  run_scan "$case1" "$log1"
  expect_rc 1 "負向樣本要抓到問題"
  expect_contains "$log1" "模式：樹掃描" "負向樣本標明樹掃描"
  expect_contains "$log1" "token.txt:1: secret:" "一般檔案中的假 token"
  expect_contains "$log1" "personal.txt:1: personal-path:" "一般檔案中的假個人路徑"
  expect_contains "$log1" "inline-allow.txt:1: secret:" "行內 gitleaks:allow 不能藏住假 token"
  expect_contains "$log1" "out/config.js:1: secret:" "tracked out/ 的假 token"
  expect_contains "$log1" "out/x.txt:1: personal-path:" "tracked out/ 的假個人路徑"
  expect_contains "$log1" "utf16le.txt:1: personal-path:" "UTF-16LE 樣本"
  expect_contains "$log1" "utf16be.txt:1: personal-path:" "UTF-16BE 樣本"
  expect_contains "$log1" "nul.txt:1: personal-path:" "含 NUL 的樣本"
  expect_contains "$log1" "invalid-utf8.txt:1: personal-path:" "非 UTF-8 的樣本"
  expect_contains "$log1" "large.txt:1: personal-path:" "超過 maxFileBytes 的樣本"
  for name in "${LOCKFILE_NAMES[@]}"; do
    expect_contains "$log1" "$name:1: secret:" "lockfile ${name} 的假 token"
  done
  expect_contains "$log1" "被跳過的檔案：0 個" "沒有任何檔案被跳過"
  expect_missing "$log1" "$fake_token" "輸出不含密鑰原文"
  expect_missing "$log1" "$fake_home" "輸出不含命中的個人路徑"
  if [ "$failures" -ne "$failures_before" ]; then
    dump_log "$log1"
  fi

  # ---- 情境二：乾淨／白名單樣本（不可以報） ----
  echo "自我測試：情境二（乾淨與白名單樣本）"
  local case2="$st_root/clean"
  local log2="$st_root/clean.log"
  make_repo "$case2"
  printf 'export const answer = 42;\n' > "$case2/clean.js"
  printf 'a = "/home/synthetic-user/demo"\nb = "https://example.com/home/post/"\n' \
    > "$case2/allowlisted.txt"
  commit_all "$case2" "synthetic clean samples"
  failures_before=$failures
  run_scan "$case2" "$log2"
  expect_rc 0 "乾淨樣本要通過"
  expect_contains "$log2" "密鑰（樹掃描）：0 處" "乾淨樣本沒有密鑰"
  expect_contains "$log2" "發現 0 處" "乾淨樣本沒有個人路徑"
  expect_contains "$log2" "被跳過的檔案：0 個" "乾淨樣本沒有跳過檔案"
  if [ "$failures" -ne "$failures_before" ]; then
    dump_log "$log2"
  fi

  # ---- 情境三：先加後刪＋兩個後門（樹掃描看不到，範圍掃描要抓到） ----
  echo "自我測試：情境三（先加後刪、範圍掃描、後門）"
  local case3="$st_root/range"
  local log3="$st_root/range.log"
  local log3tree="$st_root/range-tree.log"
  make_repo "$case3"
  printf 'base\n' > "$case3/base.txt"
  commit_all "$case3" "base"
  local base_commit
  base_commit="$(git -C "$case3" rev-parse HEAD)"

  printf 'value = "%s" # gitleaks:allow\n' "$fake_token" > "$case3/token.txt"
  printf 'root = "%s"\n' "$fake_path" > "$case3/personal.txt"
  commit_all "$case3" "add secret and personal path"
  local secret_commit
  secret_commit="$(git -C "$case3" rev-parse HEAD)"

  # 這個忽略檔在樹掃描與範圍掃描時都「存在」，指紋也正確：後門若沒關就會吞掉發現。
  printf '%s:token.txt:github-pat:1\n' "$secret_commit" > "$case3/.gitleaksignore"
  commit_all "$case3" "add gitleaksignore for the synthetic token"
  rm -f "$case3/token.txt" "$case3/personal.txt"
  commit_all "$case3" "remove them again"
  local head_commit
  head_commit="$(git -C "$case3" rev-parse HEAD)"

  failures_before=$failures
  run_scan "$case3" "$log3" env SCAN_EVENT_NAME=push \
    SCAN_EVENT_BEFORE="$base_commit" SCAN_EVENT_AFTER="$head_commit"
  expect_rc 1 "範圍掃描要抓到已刪除的假 token"
  expect_contains "$log3" "模式：範圍掃描 + 樹掃描" "標明兩者都做"
  expect_contains "$log3" "範圍掃描" "輸出說明範圍掃描"
  expect_contains "$log3" "token.txt:1: secret:" "先加後刪的假 token 仍被報出"
  expect_contains "$log3" "personal.txt:1: personal-path:" "先加後刪的假個人路徑仍被報出"
  expect_missing "$log3" "$fake_token" "範圍掃描輸出不含密鑰原文"
  expect_missing "$log3" "$fake_home" "範圍掃描輸出不含命中的個人路徑"
  if [ "$failures" -ne "$failures_before" ]; then
    dump_log "$log3"
  fi

  # 同一個 repo 只看工作樹：內容都已刪除，應該乾淨——證明情境三抓到的東西真的來自範圍。
  failures_before=$failures
  run_scan "$case3" "$log3tree"
  expect_rc 0 "同一個 repo 的樹掃描是乾淨的（證明範圍掃描有作用）"
  if [ "$failures" -ne "$failures_before" ]; then
    dump_log "$log3tree"
  fi

  if [ "$failures" -ne 0 ]; then
    echo "自我測試：失敗（${failures} 項）。" >&2
    return 1
  fi
  echo "自我測試：通過（3 個情境）。"
  return 0
}

if [ "$SELF_TEST" -eq 1 ]; then
  self_test
  exit $?
fi

# ---- 準備：把待掃檔案匯出到暫存目錄 ----

cd "$SCAN_ROOT" || fail "無法切換到掃描根目錄：$SCAN_ROOT"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mnemoshelf-privacy-scan.XXXXXX")" || fail "無法建立暫存目錄。"
cleanup() { rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT INT TERM

FILE_LIST="$TMP_DIR/file-list"
SCAN_TREE="$TMP_DIR/tree"
IGNORE_GUARD="$TMP_DIR/no-gitleaks-ignore"
mkdir -p "$SCAN_TREE" "$IGNORE_GUARD" || fail "無法建立暫存目錄。"

write_report_parser

# `--cached --others --exclude-standard`＝已追蹤 ＋ 未追蹤但未被忽略的檔案。
# 後者讓「還沒 commit 的新檔」在本機也會被掃到；已忽略的生成物則不會。
if ! git ls-files -z --cached --others --exclude-standard > "$FILE_LIST"; then
  fail "git ls-files 失敗；請在 repo 內執行（或確認 git 可用）。"
fi

# 先複製再掃：`gitleaks dir` 不讀 .gitignore，直接掃工作目錄會把 node_modules 與
# 打包產物一起掃進去（本機 node_modules 超過 1 GB），未追蹤的暫存檔也會被掃。
if ! tar --null -T "$FILE_LIST" -cf - 2>/dev/null | tar -xf - -C "$SCAN_TREE" 2>/dev/null; then
  fail "匯出待掃檔案到暫存目錄失敗（掃描期間有檔案被刪除或移動？）。"
fi

# 後門：gitleaks 會無條件讀取「掃描目標根目錄」的 `.gitleaksignore`，`-i` 擋不住它。
# 這個檔案不留在暫存樹，掃描目標就沒有忽略檔可用。
rm -f -- "$SCAN_TREE/.gitleaksignore"

# gitleaks 的預設設定把這些 lockfile 依檔名放進全域白名單。lockfile 可能夾帶 registry
# token，這裡在「暫存副本」改名以繞過那條白名單，報告輸出再映射回原名（含巢狀目錄）。
while IFS= read -r -d '' lockfile; do
  mv -- "$lockfile" "${lockfile}.scan" || fail "無法為 lockfile 建立待掃副本：$lockfile"
done < <(
  find "$SCAN_TREE" \( -type f -o -type l \) \
    \( -name pnpm-lock.yaml -o -name package-lock.json -o -name yarn.lock \
    -o -name deno.lock -o -name npm-shrinkwrap.json \) -print0
)

# ---- 決定掃描範圍（樹掃描一律執行；範圍掃描盡力而為，但工具錯誤不降級） ----

RANGE=""
RANGE_LABEL=""
RANGE_REASON=""

case "${SCAN_EVENT_NAME:-}" in
  push)
    before="${SCAN_EVENT_BEFORE:-}"
    after="${SCAN_EVENT_AFTER:-}"
    if is_zero_sha "$after" || ! commit_exists "$after"; then
      RANGE_REASON="push 事件沒有可用的 after commit（分支刪除或取不到該 commit）"
    elif ! is_zero_sha "$before" && commit_exists "$before"; then
      RANGE="${before}..${after}"
      RANGE_LABEL="push ${before:0:12}..${after:0:12}"
    else
      # 新建分支／tag（before 全零）或 before 不在本機：退回上一個版本 tag。
      previous_tag="$(git -C "$SCAN_ROOT" describe --tags --abbrev=0 --match 'v*' "${after}^" 2>/dev/null || true)"
      if [ -n "$previous_tag" ] && commit_exists "$previous_tag"; then
        RANGE="${previous_tag}..${after}"
        RANGE_LABEL="push ${previous_tag}..${after:0:12}"
        RANGE_REASON="before 全零或不存在：以最近的版本 tag ${previous_tag} 為起點"
      else
        RANGE_REASON="before 全零且找不到可用的版本 tag，無法決定範圍"
      fi
    fi
    ;;
  pull_request)
    base_ref="${GITHUB_BASE_REF:-}"
    head="${SCAN_PR_HEAD_SHA:-}"
    commit_exists "$head" || head="HEAD"
    range_base=""
    base_candidates=("${SCAN_PR_BASE_SHA:-}")
    if [ -n "$base_ref" ]; then
      base_candidates+=("origin/$base_ref" "$base_ref")
    fi
    for candidate in "${base_candidates[@]}"; do
      [ -n "$candidate" ] || continue
      commit_exists "$candidate" || continue
      merge_base="$(git -C "$SCAN_ROOT" merge-base "$candidate" "$head" 2>/dev/null || true)"
      if [ -n "$merge_base" ]; then
        range_base="$merge_base"
        RANGE="${merge_base}..${head}"
        RANGE_LABEL="pull_request ${merge_base:0:12}..${head:0:12}"
        break
      fi
    done
    if [ -z "$range_base" ]; then
      RANGE_REASON="取不到 PR 的合併基底（base=${base_ref:-未知}）；只做樹掃描，覆蓋範圍較小"
    fi
    ;;
  *)
    RANGE_REASON="沒有 CI push／pull_request 事件（本機執行或 workflow_dispatch）"
    ;;
esac

if [ -n "$RANGE" ]; then
  # 先自己驗證範圍：gitleaks 對無效的 git 範圍可能只記 ERR 卻以 0 結束，不能靠它。
  if ! git -C "$SCAN_ROOT" rev-list --count "$RANGE" >/dev/null 2>&1; then
    fail "無法解析提交範圍 ${RANGE}；掃描沒有完成（不會靜默降級成只有樹掃描）。"
  fi
fi

echo "== 掃描範圍 =="
if [ -n "$RANGE" ]; then
  echo "模式：範圍掃描 + 樹掃描（兩者都做）"
  echo "範圍：${RANGE_LABEL}（${RANGE}）"
  if [ -n "$RANGE_REASON" ]; then
    echo "說明：${RANGE_REASON}"
  fi
else
  echo "模式：樹掃描"
  echo "說明：${RANGE_REASON}"
fi

# ---- 一、密鑰掃描：工作樹 ----

echo "== 1/3 密鑰掃描（樹掃描；gitleaks ${GITLEAKS_VERSION}）=="

TREE_REPORT="$TMP_DIR/gitleaks-tree.json"
TREE_ERR="$TMP_DIR/gitleaks-tree.err"
gitleaks dir \
  --config "$CONFIG_FILE" \
  --redact \
  --no-banner \
  --no-color \
  --log-level error \
  --gitleaks-ignore-path "$IGNORE_GUARD" \
  --ignore-gitleaks-allow \
  --report-format json \
  --report-path "$TREE_REPORT" \
  "$SCAN_TREE" 2>"$TREE_ERR"
TREE_RC=$?
check_gitleaks_result "$TREE_RC" "$TREE_ERR" "樹掃描"

TREE_FINDINGS="$TMP_DIR/secret-tree-findings.txt"
parse_report "$TREE_REPORT" "$SCAN_TREE" "$TREE_FINDINGS"
TREE_COUNT="$(wc -l < "$TREE_FINDINGS" | tr -d '[:space:]')"
TREE_COUNT="${TREE_COUNT:-0}"

if [ "$TREE_RC" -eq 1 ] && [ "$TREE_COUNT" -eq 0 ]; then
  fail "gitleaks 樹掃描回報有發現，但 JSON 報告是空的；掃描沒有完成。"
fi

if [ "$TREE_COUNT" -gt 0 ]; then
  echo "密鑰（樹掃描）：發現 ${TREE_COUNT} 處"
  cat "$TREE_FINDINGS"
else
  echo "密鑰（樹掃描）：0 處"
fi

# ---- 二、密鑰掃描：提交範圍 ----

RANGE_COUNT=0
if [ -n "$RANGE" ]; then
  echo "== 2/3 密鑰掃描（提交範圍 ${RANGE_LABEL}）=="

  # 在「沒有 checkout」的暫存 clone 上掃：工作目錄沒有任何檔案，因此也不會有人
  # 在 repo 根放 `.gitleaksignore` 讓發現消失（gitleaks 會無條件讀取掃描目標的忽略檔）。
  RANGE_REPO="$TMP_DIR/range-repo"
  if ! git clone --quiet --shared --no-checkout -- "$SCAN_ROOT" "$RANGE_REPO"; then
    fail "無法為提交範圍掃描建立暫存 clone；掃描沒有完成。"
  fi

  RANGE_REPORT="$TMP_DIR/gitleaks-range.json"
  RANGE_ERR="$TMP_DIR/gitleaks-range.err"
  gitleaks git \
    --log-opts="$RANGE" \
    --config "$CONFIG_FILE" \
    --redact \
    --no-banner \
    --no-color \
    --log-level error \
    --gitleaks-ignore-path "$IGNORE_GUARD" \
    --ignore-gitleaks-allow \
    --report-format json \
    --report-path "$RANGE_REPORT" \
    "$RANGE_REPO" 2>"$RANGE_ERR"
  RANGE_RC=$?
  check_gitleaks_result "$RANGE_RC" "$RANGE_ERR" "範圍掃描"

  RANGE_FINDINGS="$TMP_DIR/secret-range-findings.txt"
  parse_report "$RANGE_REPORT" "" "$RANGE_FINDINGS"
  RANGE_COUNT="$(wc -l < "$RANGE_FINDINGS" | tr -d '[:space:]')"
  RANGE_COUNT="${RANGE_COUNT:-0}"

  if [ "$RANGE_RC" -eq 1 ] && [ "$RANGE_COUNT" -eq 0 ]; then
    fail "gitleaks 範圍掃描回報有發現，但 JSON 報告是空的；掃描沒有完成。"
  fi

  if [ "$RANGE_COUNT" -gt 0 ]; then
    echo "密鑰（提交範圍）：發現 ${RANGE_COUNT} 處"
    cat "$RANGE_FINDINGS"
  else
    echo "密鑰（提交範圍）：0 處"
  fi
else
  echo "== 2/3 密鑰掃描（提交範圍）=="
  echo "略過：${RANGE_REASON}（只做樹掃描，這不是「已掃過歷史」的證明）"
fi

# ---- 三、個人本機絕對路徑（工作樹 ＋ 提交範圍差異） ----

echo "== 3/3 個人本機路徑掃描 =="

PATH_ARGS=(--root "$SCAN_ROOT" --policy "$POLICY_FILE")
if [ -n "$RANGE" ]; then
  PATH_ARGS+=(--diff-range "$RANGE")
fi

PATH_RC=0
"$PYTHON" "$CHECKER" "${PATH_ARGS[@]}" || PATH_RC=$?

case "$PATH_RC" in
  0 | 1) ;;
  *) fail "個人本機路徑檢查沒有完成（退出碼 ${PATH_RC}）。" ;;
esac

# ---- 結果 ----

LEAK_COUNT=$((TREE_COUNT + RANGE_COUNT))

if [ -n "$RANGE" ]; then
  MODE_LABEL="範圍掃描 + 樹掃描"
else
  MODE_LABEL="樹掃描"
fi

if [ "$LEAK_COUNT" -gt 0 ] || [ "$PATH_RC" -eq 1 ]; then
  echo "隱私掃描：發現問題（模式：${MODE_LABEL}；密鑰 ${LEAK_COUNT} 處；個人本機路徑見上）。" >&2
  exit 1
fi

echo "隱私掃描：通過（模式：${MODE_LABEL}；密鑰 0 處；個人本機路徑 0 處）。"
exit 0
