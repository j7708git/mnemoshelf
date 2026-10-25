#!/usr/bin/env python3
"""掃描 repo 內檔案是否含有「個人本機絕對路徑」。

規則唯一來源是 `.github/repo-privacy-policy.json`（與本機 commit／push 前的隱私檢查共用
同一份政策）；這支腳本不另外維護一份 regex，也不在程式裡寫死任何帳號名稱。

為什麼不用 gitleaks 做這件事：gitleaks 的 regex 引擎是 Go 的 RE2，不支援負向後顧
（negative lookbehind），而政策檔的 pattern 需要 `(?<![\\w.-])` 才不會誤判 URL
（例如 `substack.com/home/post/`）與程式原始碼裡的 regex 字面。

用法：
    python3 .github/scripts/check-personal-paths.py [--root <repo 根>]

退出碼：
    0 = 乾淨
    1 = 有發現（只印位置與類型，不印命中的路徑內容）
    2 = 工具或設定錯誤（掃描沒有完成，不等於乾淨）
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

# 生成物與相依套件。`scan-repo.sh` 匯出的檔案清單本來就不含被忽略的路徑，
# 這裡再擋一層，避免有人直接對工作目錄執行時掃到大型生成物。
EXCLUDED_DIR_NAMES = {".git", "node_modules", "dist", "dist-app", "out", ".tmp", "coverage"}

# 政策檔缺少 maxFileBytes 時的後備值（與目前政策一致）。
DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024

# 比對不到帳號名稱時顯示的類型；僅用於輸出，不影響規則。
KIND_FALLBACK = "personal-path"


def fail(message: str) -> NoReturn:
    """工具／設定錯誤：印出訊息並以 2 結束（避免被誤讀成「有發現」）。"""
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

    return {"patterns": compiled, "allow": allow, "max_file_bytes": max_bytes}


def list_candidate_files(root: Path) -> list[str]:
    """列出「會進版控的檔案」：已追蹤 ＋ 未追蹤但未被忽略的新檔案。

    使用 git 而不是 os.walk 的原因：`.gitignore` 已經定義了什麼不該進 repo
    （node_modules、dist、dist-app、.tmp…），直接沿用同一份判斷最不會漏。
    `pnpm-lock.yaml` 是已追蹤檔案，因此照樣會被掃。
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


def is_excluded(relative_path: str) -> bool:
    # git 輸出以 `/` 分隔；Windows 上若有反斜線也一併處理。
    parts = re.split(r"[\\/]", relative_path)
    return any(part in EXCLUDED_DIR_NAMES for part in parts[:-1])


def decode_text(path: Path, max_file_bytes: int) -> str | None:
    """讀成 UTF-8 文字；超過大小上限、讀取失敗或看起來是二元檔就回傳 None。"""
    try:
        if path.stat().st_size > max_file_bytes:
            return None
        data = path.read_bytes()
    except OSError:
        # 讀取失敗（權限、 broken symlink…）不算發現，直接跳過。
        return None

    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        # 非 UTF-8 的內容視為二元檔；不要用寬鬆解碼硬掃，避免誤報。
        return None


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


def scan(root: Path, policy: dict) -> int:
    patterns: list[tuple[str, re.Pattern[str]]] = policy["patterns"]
    allow_prefixes: list[str] = policy["allow"]
    max_file_bytes: int = policy["max_file_bytes"]

    findings = 0
    scanned = 0

    for relative_path in list_candidate_files(root):
        if is_excluded(relative_path):
            continue

        text = decode_text(root / relative_path, max_file_bytes)
        if text is None:
            continue

        scanned += 1
        # 同一行、同一條規則只報一次（行內可能有多個路徑）。
        reported: set[tuple[int, str]] = set()
        for line_number, line in enumerate(text.splitlines(), 1):
            for pattern, compiled in patterns:
                kind = pattern_kind(pattern)
                for match in compiled.finditer(line):
                    if is_allowed(match.group(0), allow_prefixes):
                        continue
                    key = (line_number, kind)
                    if key in reported:
                        continue
                    reported.add(key)
                    # 只印位置與類型，不印命中內容（路徑本身可能含帳號）。
                    print(f"{relative_path}:{line_number}: {KIND_FALLBACK}:{kind}")
                    findings += 1

    print(f"個人本機路徑：掃描 {scanned} 個檔案，發現 {findings} 處。")
    return 1 if findings else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="掃描 repo 內是否含有個人本機絕對路徑（規則來自 .github/repo-privacy-policy.json）。"
    )
    parser.add_argument(
        "--root",
        help="repo 根目錄（預設由腳本位置推得：<repo>/.github/scripts/ 往上兩層）。",
    )
    parser.add_argument(
        "--policy",
        help="政策檔路徑（預設 <root>/.github/repo-privacy-policy.json）。",
    )
    args = parser.parse_args(argv)

    root = repo_root_from_args(args.root)
    if not root.is_dir():
        fail(f"--root 不是目錄：{root}")

    policy_path = Path(args.policy).resolve() if args.policy else root / ".github" / "repo-privacy-policy.json"
    policy = load_policy(policy_path)

    if hasattr(sys.stdout, "reconfigure"):
        # 檔名含非 UTF-8 位元組時，寧可跳脫顯示也不要讓整支腳本因編碼錯誤中止。
        sys.stdout.reconfigure(errors="backslashreplace")

    return scan(root, policy)


if __name__ == "__main__":
    sys.exit(main())
