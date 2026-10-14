/**
 * 「加入資料夾」引導流程（本卡不改 roots 契約，以 UI 流程達成「先預覽再加入」）：
 *
 *   輸入路徑 → `POST /roots`（mode: index）→ `POST /roots/:id/preview`（統計，不寫入）
 *   → 使用者按「開始索引」→ `POST /roots/:id/index`（背景執行）＋輪詢
 *   `GET /roots/:id/index/status` → 完成。
 *
 * 在預覽階段取消時會 `DELETE /roots/:id`（此時尚未索引，沒有資料要刪）。
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  addRoot,
  getIndexStatus,
  previewRoot,
  removeRoot,
  startIndex,
  type IndexStatus,
  type Root,
  type RootPreview,
} from "./api";
import { formatBytes } from "./format";

export interface AddRootFlowProps {
  /** 使用者取消（尚未加入或加入後反悔）。 */
  onCancel: () => void;
  /** 索引完成；帶回新加入的 root。 */
  onDone: (root: Root) => void;
}

type Step = "input" | "preview" | "indexing" | "done" | "failed";

/** 被跳過的原因 → 中文標籤。 */
const SKIP_REASON_LABEL: Record<string, string> = {
  blocked: "黑名單",
  excluded: "排除規則",
  "modality-off": "未開啟的模態",
  "too-large": "超過大小上限",
  "unsupported-type": "不支援的型別",
  "unresolved-symlink": "無法解析的連結",
  "symlink-dir": "符號連結目錄",
  "not-a-file": "非一般檔案",
};

/** 模態 → 中文標籤。 */
const MODALITY_LABEL: Record<string, string> = {
  text: "文字",
  code: "程式碼",
  image: "圖片",
  audio: "音訊",
  video: "影片",
};

function skipSummary(skipped: RootPreview["skipped"]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}

export function AddRootFlow({ onCancel, onDone }: AddRootFlowProps) {
  const [pathInput, setPathInput] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [root, setRoot] = useState<Root | null>(null);
  const [preview, setPreview] = useState<RootPreview | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // onDone 用 ref 取用，避免它每次 render 改變就重啟輪詢。
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const submitPath = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const target = pathInput.trim();
    if (target === "") return;
    setBusy(true);
    setError(null);
    try {
      const created = await addRoot({ path: target });
      const stats = await previewRoot(created.id);
      setRoot(created);
      setPreview(stats);
      setStep("preview");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "加入資料夾失敗");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (root !== null) {
      try {
        await removeRoot(root.id);
      } catch {
        // 移除失敗不擋住流程：使用者仍可關閉這個畫面。
      }
    }
    onCancel();
  };

  const beginIndex = (): void => {
    if (root === null) return;
    setError(null);
    setStep("indexing");
    // 不 await：POST /index 會等索引跑完才回應，進度靠輪詢。
    void startIndex(root.id).catch((indexError: unknown) => {
      setError(indexError instanceof Error ? indexError.message : "索引失敗");
      setStep("failed");
    });
  };

  // 索引中：每 800ms 輪詢一次狀態，直到 completed／failed。
  useEffect(() => {
    if (step !== "indexing" || root === null) return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const current = await getIndexStatus(root.id);
        if (cancelled) return;
        setStatus(current);
        if (current.state === "completed") {
          setStep("done");
          onDoneRef.current(root);
        } else if (current.state === "failed") {
          setError(current.error?.message ?? "索引失敗");
          setStep("failed");
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : "讀取索引进度失敗");
          setStep("failed");
        }
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 800);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [step, root]);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-white p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium text-ink">加入資料夾</h2>
        {step === "input" && (
          <button type="button" onClick={onCancel} className="text-sm text-muted underline">
            取消
          </button>
        )}
      </div>

      {step === "input" && (
        <form onSubmit={(event) => void submitPath(event)} className="space-y-3">
          <label htmlFor="add-root-path" className="block text-sm font-medium text-ink">
            資料夾的完整路徑
          </label>
          <input
            id="add-root-path"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder="例如 ~/Documents/notes（貼上實際路徑）"
            spellCheck={false}
            className="w-full rounded-md border border-line bg-white px-3 py-2 font-mono text-sm text-ink outline-none focus:border-ink"
          />
          <p className="text-xs text-muted">
            服務只會讀取這個資料夾；家目錄本身與檔案系統根目錄會被拒絕。加入後會先顯示統計，確認才開始索引。
          </p>
          {error !== null && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || pathInput.trim() === ""}
            className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "加入中…" : "加入並預覽"}
          </button>
        </form>
      )}

      {step === "preview" && preview !== null && root !== null && (
        <div className="space-y-4">
          <p className="break-all font-mono text-xs text-muted">{root.path}</p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="檔案數" value={String(preview.totalFiles)} />
            <Stat label="總大小" value={formatBytes(preview.totalBytes)} />
            <Stat label="預估索引量" value={`${preview.estimatedChunks} 塊`} />
            <Stat label="預估時間" value={`約 ${preview.estimatedSeconds} 秒`} />
          </div>

          <div>
            <h3 className="text-sm font-medium text-ink">類型分佈</h3>
            <ul className="mt-1 space-y-1 text-sm text-muted">
              {Object.entries(preview.byKind)
                .filter(([, stat]) => stat.count > 0)
                .map(([kind, stat]) => (
                  <li key={kind}>
                    {MODALITY_LABEL[kind] ?? kind}：{stat.count} 個（{formatBytes(stat.bytes)}）
                  </li>
                ))}
              {preview.totalFiles === 0 && <li>沒有可索引的檔案。</li>}
            </ul>
          </div>

          {preview.skipped.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-ink">將被跳過的檔案（{preview.skipped.length} 個）</h3>
              <ul className="mt-1 space-y-1 text-sm text-muted">
                {skipSummary(preview.skipped).map((item) => (
                  <li key={item.reason}>
                    {SKIP_REASON_LABEL[item.reason] ?? item.reason}：{item.count} 個
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error !== null && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={beginIndex}
              disabled={preview.totalFiles === 0}
              className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              開始索引
            </button>
            <button
              type="button"
              onClick={() => void cancel()}
              className="rounded-md border border-line px-3 py-2 text-sm text-ink"
            >
              取消（移除這個資料夾）
            </button>
          </div>
        </div>
      )}

      {step === "indexing" && (
        <div className="space-y-3">
          <p className="text-sm text-ink">正在建立索引…（可以放著，完成後會自動顯示）</p>
          <ProgressBar status={status} />
        </div>
      )}

      {step === "done" && (
        <p className="text-sm text-ink">索引完成，目錄樹已可使用。</p>
      )}

      {step === "failed" && (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-red-600">
            索引失敗：{error ?? "未知錯誤"}
          </p>
          {root !== null && (
            <button
              type="button"
              onClick={beginIndex}
              className="rounded-md border border-line px-3 py-2 text-sm text-ink"
            >
              重試
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-ink">{value}</p>
    </div>
  );
}

function ProgressBar({ status }: { status: IndexStatus | null }) {
  const progress = status?.progress ?? null;
  const total = progress?.total ?? 0;
  const processed = progress?.processed ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  return (
    <div className="space-y-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-line">
        <div className="h-full bg-ink transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-xs text-muted">
        {total > 0
          ? `已處理 ${processed}／${total} 個檔案（${percent}%），跳過未變更 ${progress?.skippedUnchanged ?? 0} 個`
          : "正在掃描檔案…"}
      </p>
    </div>
  );
}
