#!/usr/bin/env python3
"""掃描「個人本機絕對路徑」：目前工作樹的檔案，以及指定 commit 範圍的差異文字。

規則來源：**這個 repo 以 `.github/repo-privacy-policy.json` 為準**。工作區層級另有一份
`.openchamber/repo-privacy-policy.json` 給其他專案的本機 hook 使用；兩份內容目前相同，
但各自獨立、沒有同步機制——改規則時兩邊都要改。這支腳本不另外維護一份 regex，也不在
程式裡寫死任何帳號名稱。

這支腳本**不跳過檔案**：UTF-16（BOM 判斷）、含 NUL、非 UTF-8 的內容一律寬鬆解碼後照樣掃，
超過政策 `maxFileBytes` 的檔案改成逐行串流掃描。真的讀不到的檔案會列出來並以退出碼 2
結束（掃描沒有完成），不會回報成「乾淨」。

CI 一律以 `personalPathSeverity = high` 擋下：政策值只影響輸出顯示；即使政策檔把等級
調低，這支腳本仍會用同一組 pattern 找出並回報（比本機 hook 更嚴，避免本機與 CI 分叉）。

為什麼不用 gitleaks 做這件事：gitleaks 的 regex 引擎是 Go 的 RE2，不支援負向後顧
（negative lookbehind），而政策檔的 pattern 需要 `(?<![\\w.-])` 才不會誤判 URL
（例如 `substack.com/home/post/`）與程式原始碼裡的 regex 字面。

這支腳本由 CI 呼叫，但 CI 是**事後偵測**：只掃這次事件的工作樹與提交範圍，**不涵蓋**更早的
歷史 commit（除非落在這次範圍內）、force push 覆蓋掉的中間 commit、commit message／PR 描述、
GitHub 以外的備份，也不是推送當下的阻擋（事前阻擋靠本機 hook 與 GitHub 的 push protection）。

用法：
    python3 .github/scripts/check-personal-paths.py [--root <repo 根>]
                                                    [--diff-range <git 範圍>]

退出碼：
    0 = 乾淨
    1 = 有發現（只印位置與類型，不印命中的路徑內容）
    2 = 工具或設定錯誤（掃描沒有完成，不等於乾淨；包含「有檔案被跳過」）
"""

from __future__ import annotations

import argparse
import io
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Iterator, NoReturn

# 政策檔缺少 maxFileBytes 時的後備值（與目前政策一致）。這個值只用來標示「大型檔案」，
# 不論大小都會掃描（逐行串流），不會因為超過它而跳過。
DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024

# 比對不到帳號名稱時顯示的類型；僅用於輸出，不影響規則。
KIND_FALLBACK = "personal-path"

# BOM：用來判斷 UTF-16（沒有 BOM 的 UTF-16 無法可靠判斷，會走寬鬆解碼，仍不會被跳過）。
UTF16_LE_BOM = b"\xff\xfe"
UTF16_BE_BOM = b"\xfe\xff"
UTF8_BOM = b"\xef\xbb\xbf"

# 檔案標頭與 hunk 標頭（`git log -p -U0` 的輸出）。
DIFF_HUNK = re.compile(r"^@@ -(?P<old>\d+)(?:,\d+)? \+(?P<new>\d+)(?:,\d+)? @@")
COMMIT_MARKER = "\x01"


def fail(message: str) -> NoReturn:
    """工具／設定錯誤：印出訊息並以 2 結束（避免被誤讀成「有發現」）。"""
    sys.stdout.flush()
    print(f"錯誤：{message}", file=sys.stderr)
    sys.exit(2)


def repo_root_from_args(explicit_root: str | None) -> Path:
    if explicit_root:
        return Path(explicit_root).resolve()
    # 腳本位於 <repo>/.github/scripts/，往上兩層就是 repo 根。
    return Path(__file__).resolve().parents[2]


def load_policy(policy_path: Path) -> dict:
    try:
        with policy_path.open(encoding="utf-8") as handle:
            policy = json.load(handle)
    except OSError as exc:
        fail(f"讀不到政策檔 {policy_path}：{exc}")
    except UnicodeDecodeError as exc:
        fail(f"政策檔不是 UTF-8：{policy_path}：{exc}")
    except json.JSONDecodeError as exc:
        fail(f"政策檔不是合法 JSON：{policy_path}：{exc}")

    paths = policy.get("paths") if isinstance(policy, dict) else None
    if not isinstance(paths, dict):
        fail(f"政策檔缺少 paths 區塊：{policy_path}")

    raw_patterns = paths.get("personalPathPatterns")
    if not isinstance(raw_patterns, list) or not raw_patterns:
        fail(f"政策檔的 paths.personalPathPatterns 必須是非空陣列：{policy_path}")

    compiled: list[tuple[str, re.Pattern[str]]] = []
    for raw in raw_patterns:
        if not isinstance(raw, str) or not raw:
            fail(f"政策檔的 personalPathPatterns 含非字串項目：{policy_path}")
        try:
            compiled.append((raw, re.compile(raw)))
        except re.error as exc:
            fail(f"政策檔的 regex 無法編譯（{raw}）：{exc}")

    allow = paths.get("personalPathAllow")
    if allow is None:
        allow = []
    if not isinstance(allow, list) or any(not isinstance(item, str) for item in allow):
        fail(f"政策檔的 paths.personalPathAllow 必須是字串陣列：{policy_path}")

    max_bytes = paths.get("maxFileBytes", DEFAULT_MAX_FILE_BYTES)
    if not isinstance(max_bytes, int) or max_bytes <= 0:
        fail(f"政策檔的 paths.maxFileBytes 必須是正整數：{policy_path}")

    severity = paths.get("personalPathSeverity", "high")
    if not isinstance(severity, str) or not severity:
        fail(f"政策檔的 paths.personalPathSeverity 必須是非空字串：{policy_path}")

    return {
        "patterns": compiled,
        "allow": allow,
        "max_file_bytes": max_bytes,
        "severity": severity,
    }


def list_candidate_files(root: Path) -> list[str]:
    """列出「會進版控的檔案」：已追蹤 ＋ 未追蹤但未被忽略的新檔案。

    使用 git 而不是 os.walk 的原因：`.gitignore` 已經定義了什麼不該進 repo
    （node_modules、dist、dist-app、.tmp…），直接沿用同一份判斷最不會漏。
    **已被追蹤的檔案一律納入**：即使它放在 out/、dist/ 這種生成物目錄裡
    （例如 `git add -f out/config.js`），也照樣會掃——是否進版控才是判準，
    不是目錄名稱。
    """
    try:
        completed = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
    except FileNotFoundError:
        fail("找不到 git；請在 repo 內執行，或先安裝 git。")
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", "replace").strip()
        fail(f"git ls-files 失敗（請確認在 repo 根目錄執行）：{detail}")

    names = completed.stdout.split(b"\0")
    result: list[str] = []
    for name in names:
        if not name:
            continue
        result.append(name.decode("utf-8", "surrogateescape"))
    return result


def detect_encoding(head: bytes) -> str:
    """依 BOM 決定解碼方式；其餘（含含 NUL 的內容）一律 UTF-8 寬鬆解碼。"""
    if head.startswith(UTF16_LE_BOM) or head.startswith(UTF16_BE_BOM):
        # `utf-16` 會讀 BOM 判斷位元組序，並把 BOM 本身去掉。
        return "utf-16"
    if head.startswith(UTF8_BOM):
        return "utf-8-sig"
    return "utf-8"


def iter_lines(path: Path) -> Iterator[str]:
    """逐行讀檔（不整檔載入記憶體）。

    非 UTF-8、含 NUL、二進位內容都用 `errors="replace"` 解碼後照樣掃描：我們找的是
    ASCII 路徑字串，寬鬆解碼不會漏掉連續的 ASCII，也不會因此多報（比對仍是精確 regex）。
    """
    with path.open("rb") as raw:
        head = raw.read(4)
        raw.seek(0)
        wrapper = io.TextIOWrapper(
            raw, encoding=detect_encoding(head), errors="replace", newline=None
        )
        for line in wrapper:
            yield line.rstrip("\r\n")


def pattern_kind(pattern: str) -> str:
    """給輸出用的類型名稱（不影響比對）。"""
    if "/home/" in pattern:
        return "unix-home"
    if "/Users/" in pattern:
        return "macos-users"
    if "Users" in pattern:
        return "windows-users"
    return KIND_FALLBACK


def is_allowed(matched_text: str, allow_prefixes: list[str]) -> bool:
    """政策檔的白名單是前綴字串（例如 `/home/runner/`）。

    只比較前綴、不做子字串比對，避免 `/home/user/` 意外放行 `/home/username/`。
    """
    return any(matched_text.startswith(prefix) for prefix in allow_prefixes)


def line_matches(
    line: str,
    patterns: list[tuple[str, re.Pattern[str]]],
    allow_prefixes: list[str],
) -> list[str]:
    """回傳這一行命中的類型（同一行、同一條規則只算一次）。"""
    kinds: list[str] = []
    seen: set[str] = set()
    for pattern, compiled in patterns:
        kind = pattern_kind(pattern)
        if kind in seen:
            continue
        for match in compiled.finditer(line):
            if is_allowed(match.group(0), allow_prefixes):
                continue
            kinds.append(kind)
            seen.add(kind)
            break
    return kinds


def report_severity(severity: str) -> None:
    if severity.lower() == "high":
        print(f"個人本機路徑：政策 severity={severity}（本 repo 政策值）。")
    else:
        print(
            f"個人本機路徑：政策 severity={severity}；"
            "CI 一律以 high 擋下（比本機 hook 更嚴，避免兩邊分叉）。"
        )


def scan(root: Path, policy: dict) -> int:
    patterns: list[tuple[str, re.Pattern[str]]] = policy["patterns"]
    allow_prefixes: list[str] = policy["allow"]
    max_file_bytes: int = policy["max_file_bytes"]

    report_severity(policy["severity"])

    findings = 0
    scanned = 0
    large_files = 0
    skipped: list[str] = []

    print("個人本機路徑（工作樹）：")

    for relative_path in list_candidate_files(root):
        target = root / relative_path
        try:
            size = target.stat().st_size
        except OSError:
            skipped.append(relative_path)
            continue

        if size > max_file_bytes:
            large_files += 1

        reported: set[tuple[int, str]] = set()
        try:
            for line_number, line in enumerate(iter_lines(target), 1):
                for kind in line_matches(line, patterns, allow_prefixes):
                    key = (line_number, kind)
                    if key in reported:
                        continue
                    reported.add(key)
                    # 只印位置與類型，不印命中內容（路徑本身可能含帳號）。
                    print(f"{relative_path}:{line_number}: {KIND_FALLBACK}:{kind}")
                    findings += 1
        except (OSError, UnicodeError):
            # 讀到一半失敗：列進跳過清單，最後以 2 結束（掃描沒有完成）。
            skipped.append(relative_path)
            continue

        scanned += 1

    print(
        f"個人本機路徑（工作樹）：掃描 {scanned} 個檔案"
        f"（其中 {large_files} 個超過 maxFileBytes={max_file_bytes}，已逐行串流掃描），"
        f"發現 {findings} 處。"
    )

    return skipped, findings


def finish(skipped: list[str], findings: int) -> int:
    if skipped:
        sys.stdout.flush()
        print(f"被跳過的檔案（{len(skipped)} 個；掃描沒有完成）：", file=sys.stderr)
        for relative_path in skipped:
            print(f"  {relative_path}", file=sys.stderr)
        print(f"被跳過的檔案：{len(skipped)} 個", file=sys.stderr)
        return 2
    print("被跳過的檔案：0 個")
    return 1 if findings else 0


def _diff_path(raw: str) -> str:
    """從 `+++ b/path` / `--- a/path` 取出 repo 相對路徑。"""
    path = raw.strip()
    if path.startswith('"') and path.endswith('"') and len(path) >= 2:
        path = path[1:-1]
    if path == "/dev/null":
        return ""
    if path.startswith("b/") or path.startswith("a/"):
        path = path[2:]
    return path


def scan_diff(root: Path, rev_range: str, policy: dict) -> int:
    """掃描指定 commit 範圍的差異文字（`git log -p`），只印位置。

    為什麼要掃差異：只掃工作樹會漏掉「同一批 push 裡先加後刪」的內容——那些內容在
    工作樹已經看不到了，但確實被推上去過。
    """
    patterns: list[tuple[str, re.Pattern[str]]] = policy["patterns"]
    allow_prefixes: list[str] = policy["allow"]

    command = [
        "git",
        "-C",
        str(root),
        "-c",
        "core.quotePath=false",
        "log",
        "-p",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--no-show-signature",
        f"--format={COMMIT_MARKER}%H",
        rev_range,
        "--",
    ]
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        fail("找不到 git；無法掃描提交範圍的差異。")

    if process.stdout is None:  # pragma: no cover - 防禦性檢查
        fail("無法讀取 git log 輸出。")

    findings = 0
    matched_lines = 0
    commit = ""
    path = ""
    old_line = 0
    new_line = 0
    in_hunk = False
    reported: set[tuple[str, str, int, str]] = set()

    for raw in process.stdout:
        line = raw.decode("utf-8", "replace").rstrip("\n")
        if line.startswith(COMMIT_MARKER):
            commit = line[len(COMMIT_MARKER):].strip()
            path = ""
            in_hunk = False
            continue
        if line.startswith("diff --git "):
            path = ""
            old_line = new_line = 0
            in_hunk = False
            continue
        hunk = DIFF_HUNK.match(line)
        if hunk:
            old_line = int(hunk.group("old"))
            new_line = int(hunk.group("new"))
            in_hunk = True
            continue
        # 檔案標頭只在 hunk 之外解讀：hunk 內容本身可能是 `--- foo` 這種刪除行，
        # 不能被誤認為檔案標頭。
        if not in_hunk and line.startswith("--- "):
            path = path or _diff_path(line[4:])
            continue
        if not in_hunk and line.startswith("+++ "):
            path = _diff_path(line[4:]) or path
            continue

        if line.startswith("+") or line.startswith("-"):
            if not path:
                continue
            content = line[1:]
            if line.startswith("+"):
                line_number = new_line
                new_line += 1
            else:
                line_number = old_line
                old_line += 1
            if not content:
                continue
            matched_lines += 1
            for kind in line_matches(content, patterns, allow_prefixes):
                key = (commit, path, line_number, kind)
                if key in reported:
                    continue
                reported.add(key)
                short = commit[:7] or "?"
                print(
                    f"{path}:{line_number}: {KIND_FALLBACK}:{kind} "
                    f"(commit {short})"
                )
                findings += 1
            continue

        if line.startswith(" "):
            # `-U0` 正常不會有 context 行；保險起見仍讓行號前進。
            old_line += 1
            new_line += 1

    process.stdout.close()
    stderr = b""
    if process.stderr is not None:
        stderr = process.stderr.read()
        process.stderr.close()
    return_code = process.wait()
    if return_code != 0:
        detail = stderr.decode("utf-8", "replace").strip()
        fail(f"git log {rev_range} 失敗（退出碼 {return_code}）：{detail}")

    print(
        f"個人本機路徑（提交範圍 {rev_range}）：掃描 {matched_lines} 行差異，"
        f"發現 {findings} 處。"
    )
    return 1 if findings else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="掃描個人本機絕對路徑（規則來自 .github/repo-privacy-policy.json）。"
    )
    parser.add_argument(
        "--root",
        help="repo 根目錄（預設由腳本位置推得：<repo>/.github/scripts/ 往上兩層）。",
    )
    parser.add_argument(
        "--policy",
        help="政策檔路徑（預設 <root>/.github/repo-privacy-policy.json）。",
    )
    parser.add_argument(
        "--diff-range",
        help="額外掃描這個 git 範圍的差異文字（例如 before..after）；省略時只掃工作樹。",
    )
    args = parser.parse_args(argv)

    root = repo_root_from_args(args.root)
    if not root.is_dir():
        fail(f"--root 不是目錄：{root}")

    policy_path = (
        Path(args.policy).resolve() if args.policy else root / ".github" / "repo-privacy-policy.json"
    )
    policy = load_policy(policy_path)

    if hasattr(sys.stdout, "reconfigure"):
        # 檔名含非 UTF-8 位元組時，寧可跳脫顯示也不要讓整支腳本因編碼錯誤中止。
        sys.stdout.reconfigure(errors="backslashreplace")

    tree_skipped, tree_findings = scan(root, policy)
    diff_code = 0
    if args.diff_range:
        print(f"個人本機路徑（提交範圍 {args.diff_range}）：")
        diff_code = scan_diff(root, args.diff_range, policy)
        if diff_code == 2:
            return 2

    tree_code = finish(tree_skipped, tree_findings)
    if tree_code == 2:
        return 2
    if tree_code == 1 or diff_code == 1:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
