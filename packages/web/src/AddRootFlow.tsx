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
  cancelIndexWithRetry,
  getIndexStatus,
  IndexPollGate,
  isIndexAlreadyRunningError,
  previewRoot,
  removeRoot,
  startIndex,
  updateRootModalities,
  type IndexStatus,
  type PollBaseline,
  type PollTrack,
  type Root,
  type RootPreview,
  type VideoCapability,
  type VideoPreviewEstimate,
} from "./api";
import { formatBytes } from "./format";
import { toggleModality } from "./audio";
import { AudioModelStatus } from "./AudioModelStatus";
import {
  DEFAULT_VIDEO_MAX_FILE_BYTES,
  describeVideoEntries,
  effectiveVideoMaxFileBytes,
  formatVideoLimitBytes,
  formatVideoLimitSeconds,
  isVideoReason,
  parseVideoLimitMiB,
  videoLimitMiBDefault,
  videoReasonLabel,
  VIDEO_LIMIT_MAX_MIB,
  VIDEO_LIMIT_MIN_MIB,
  VIDEO_MAX_DURATION_SECONDS,
  VIDEO_SEGMENT_SECONDS,
  videoToggleState,
} from "./media";

export interface AddRootFlowProps {
  /** 使用者取消（尚未加入或加入後反悔）。 */
  onCancel: () => void;
  /** 索引完成；帶回新加入的 root。 */
  onDone: (root: Root) => void;
  /**
   * `POST /roots` 成功後立即回呼（此時還沒預覽／索引）。
   *
   * 讓外層可以刷新側欄的 roots 清單，並把新 root 定入畫面；流程本身**不會**被關閉。
   */
  onRootCreated?: (root: Root) => void;
  /**
   * 流程中途改了 root 設定（例如在預覽頁開關「含圖片」）後回呼。
   *
   * 用途與 `onRootCreated` 相同：讓側欄的 roots 清單（模態標示）不要顯示過期狀態。
   */
  onRootChanged?: (root: Root) => void;
  /**
   * 服務層影片能力（`GET /roots` 的 `video`）。
   *
   * 非 `available` 時「含影片」開關停用並顯示原因（不讓使用者開了才在索引時全數失敗）；
   * `null`＝服務未回報（舊版服務），同樣停用並說明。
   */
  videoCapability?: VideoCapability | null;
}

type Step = "input" | "preview" | "preview-failed" | "indexing" | "cancelled" | "done" | "failed";

/** 索引中輪詢間隔（毫秒）；同時用來把 `INDEX_POLL_GRACE_MS` 換算成寬限 tick 數。 */
const POLL_INTERVAL_MS = 800;

/** 被跳過的原因 → 中文標籤。 */
const SKIP_REASON_LABEL: Record<string, string> = {
  blocked: "黑名單",
  excluded: "排除規則",
  "modality-off": "未開啟的模態",
  "unsupported-modality": "尚未支援的媒體類型",
  "unsupported-audio-format": "音訊格式未支援（目前支援 WAV）",
  "invalid-audio": "音訊內容損毀或無法解碼",
  "audio-limit-exceeded": "音訊超出時長或解碼上限",
  "too-large": "超過大小上限",
  "unsupported-type": "不支援的型別",
  "unresolved-symlink": "無法解析的連結",
  "symlink-dir": "符號連結目錄",
  "not-a-file": "非一般檔案",
  "binary-content": "內容像二進位檔",
  undecodable: "無法解碼或超出媒體限制",
};

/** 模態 → 中文標籤。 */
const MODALITY_LABEL: Record<string, string> = {
  text: "文字",
  code: "程式碼",
  image: "圖片",
  audio: "音訊",
  video: "影片",
};

/**
 * 由「是否含圖片」組出要寫入 root 的模態清單。
 *
 * 勾了圖片＝`text`／`code`／`image`；沒勾則維持 v0.1.2 的預設（不加圖片）。
 * 音訊開關另外疊加，不因切換照片清除其他模態。
 */
export function modalitiesForImages(enabled: boolean): string[] {
  return enabled ? ["text", "code", "image"] : ["text", "code"];
}

function skipSummary(skipped: RootPreview["skipped"]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}

export function AddRootFlow({ onCancel, onDone, onRootCreated, onRootChanged, videoCapability }: AddRootFlowProps) {
  const videoToggle = videoToggleState(videoCapability ?? null);
  const [pathInput, setPathInput] = useState("");
  /**
   * 這個資料夾含照片嗎？（**預設關**：文字／程式碼照舊，照片索引較慢不要嚇到人）
   *
   * 加入時就決定第一次 `POST /roots` 的模態；加入後在預覽頁改成 PATCH（見 `setImagesEnabled`）。
   */
  const [includeImages, setIncludeImages] = useState(false);
  const [includeAudio, setIncludeAudio] = useState(false);
  /** 影片模態（**預設關**；非 `available` 時整段停用，見 `videoToggle`）。 */
  const [includeVideo, setIncludeVideo] = useState(false);
  /**
   * 影片單檔大小上限（UI 輸入單位：整數 MiB；送出時換算成 bytes）。
   *
   * 預設沿用服務層預設（正常是 512 MiB）；**與影片模態無關**——影片未開啟也可以先設定，
   * 值會在 root 建立時一併寫入（契約：POST /roots 的 additive `videoMaxFileBytes`）。
   */
  const [videoLimitMiB, setVideoLimitMiB] = useState<string>(() => videoLimitMiBDefault(videoCapability?.maxFileBytes));
  /** 目前輸入的解析結果；不合法時阻擋送出並顯示原因（不默默截斷）。 */
  const videoLimit = parseVideoLimitMiB(videoLimitMiB);
  const [step, setStep] = useState<Step>("input");
  const [root, setRoot] = useState<Root | null>(null);
  const [preview, setPreview] = useState<RootPreview | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  /**
   * 寬限用盡仍沒觀察到本輪（`stalled`）：只顯示可恢復提示，不當成最終失敗。
   *
   * 因為這可能只是「索引註冊較慢」，並非真的失敗；`failed` 步驟據此改顯示提示而非「索引失敗」。
   */
  const [stalled, setStalled] = useState(false);

  // 使用者是否按過「取消索引」。`POST /index` 會在中止後才回應，這個旗標讓它的
  // rejection／回應不被誤判成「索引失敗」。
  const cancelRequestedRef = useRef(false);

  /**
   * 「開始索引」的**同步**防重入鎖。
   *
   * 為什麼必須同步（在任何 await 之前就檢查並設 true）：`setStep`／按鈕 disabled 都是
   * React state，要等下一次 render 才生效；快速雙擊的第二次點擊會在 render 之前就進到
   * `beginIndex`。若等到 preflight 的 `await` 之後才防護，兩次點擊會各送出一份
   * `POST /index`，第二份被伺服器以 409 拒絕、其 catch 會把流程誤判成 failed 並停掉輪詢，
   * 但第一份 job 仍在跑。以 ref 在入口同步擋下，第二次呼叫直接返回，不會送出第二份請求。
   */
  const indexStartingRef = useRef(false);

  /**
   * 本輪的輪詢門控（見 `IndexPollGate`）。
   *
   * 為什麼是 ref 而非 effect 內的區域變數：`beginIndex` 先同步完成 UI 轉場（進入
   * `indexing`，輪詢 effect 隨即起跑），此時 preflight（`getIndexStatus`）還沒回來、
   * baseline 尚未定案。先以 `"unknown"` 模式建立 gate（見 `PollBaseline`：不會因取不到
   * baseline 而誤停輪詢），preflight 定案後再把整個 gate 換成帶正確 baseline 的新物件。
   * 輪詢每次 tick 都讀 `pollGateRef.current`，因此換 gate 立即生效。
   */
  const pollGateRef = useRef<IndexPollGate>(new IndexPollGate("unknown", POLL_INTERVAL_MS));

  /** 目前的步驟（供非同步回呼在 await 後判斷流程是否仍停在 `indexing`）。 */
  const stepRef = useRef<Step>("input");
  stepRef.current = step;

  // onDone／onRootCreated 用 ref 取用，避免它們每次 render 改變就重啟輪詢或重跑流程。
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onRootCreatedRef = useRef(onRootCreated);
  onRootCreatedRef.current = onRootCreated;
  const onRootChangedRef = useRef(onRootChanged);
  onRootChangedRef.current = onRootChanged;

  /** 對已加入的 root 做乾跑預覽；失敗時停在可重試的 `preview-failed`，不再回到輸入步驟。 */
  const loadPreview = async (target: Root): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const stats = await previewRoot(target.id);
      setPreview(stats);
      setStep("preview");
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "讀取預覽統計失敗");
      setStep("preview-failed");
    } finally {
      setBusy(false);
    }
  };

  /**
   * 切換「這個資料夾含照片」（root 已存在時走 `PATCH /roots/:id`）。
   *
   * 為什麼在預覽頁也要能改：常常是「加入之後才看到裡面有幾千張照片」（或反之），
   * 而模態本來就可以改——就在看得到張數與預估時間的這一頁讓使用者改，改完立刻重跑預覽。
   * 失敗時把開關回復原狀（不要讓畫面顯示一個沒生效的狀態）。
   */
  const setImagesEnabled = async (enabled: boolean): Promise<void> => {
    if (root === null || busy) return;
    setIncludeImages(enabled);
    setError(null);
    setBusy(true);
    let updated: Root | null = null;
    try {
      updated = await updateRootModalities(root.id, toggleModality(root.modalities, "image", enabled));
    } catch (patchError) {
      setIncludeImages(!enabled);
      setError(patchError instanceof Error ? patchError.message : "更新資料夾設定失敗");
      setBusy(false);
      return;
    }
    setRoot(updated);
    setBusy(false);
    onRootChangedRef.current?.(updated);
    await loadPreview(updated);
  };

  const setAudioEnabled = async (enabled: boolean): Promise<void> => {
    if (root === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateRootModalities(root.id, toggleModality(root.modalities, "audio", enabled));
      setRoot(updated);
      setIncludeAudio(enabled);
      onRootChangedRef.current?.(updated);
      await loadPreview(updated);
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : "更新音訊設定失敗");
    } finally {
      setBusy(false);
    }
  };

  /**
   * 切換已加入 root 的影片模態（`PATCH /roots/:id`），成功後重跑預覽。
   *
   * 只在 capability 可用時才會被呼叫（開關本身已停用）；失敗時顯示錯誤並重跑預覽還原。
   */
  const setVideoEnabled = async (enabled: boolean): Promise<void> => {
    if (root === null || busy || !videoToggle.enabled) return;
    setIncludeVideo(enabled);
    setBusy(true);
    setError(null);
    try {
      const updated = await updateRootModalities(root.id, toggleModality(root.modalities, "video", enabled));
      setRoot(updated);
      onRootChangedRef.current?.(updated);
      await loadPreview(updated);
    } catch (patchError) {
      setIncludeVideo(!enabled);
      setError(patchError instanceof Error ? patchError.message : "更新影片設定失敗");
      setBusy(false);
    }
  };

  const submitPath = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const target = pathInput.trim();
    if (target === "") return;
    // 影片上限是合法的正整數 MiB 才送出；錯誤在欄位下方顯示，不默默改成預設值。
    if (!videoLimit.ok) {
      setError(videoLimit.message);
      return;
    }
    setError(null);
    setBusy(true);
    let created: Root | null = null;
    try {
      // 勾了「含圖片」才帶 image 模態；沒勾與 v0.1.2 完全相同（服務端預設 text／code）。
      created = await addRoot({
        path: target,
        modalities: toggleModality(
          toggleModality(modalitiesForImages(includeImages), "audio", includeAudio),
          "video",
          includeVideo && videoToggle.enabled,
        ),
        // 一律明帶這個 root 的上限（bytes）；範圍與換算已在 UI 端驗證。
        videoMaxFileBytes: videoLimit.bytes,
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "加入資料夾失敗");
    }
    if (created === null) {
      setBusy(false);
      return;
    }
    // 加入成功：先定入流程狀態並刷新側欄，之後即使預覽失敗也能正常「取消（移除）」。
    setRoot(created);
    onRootCreatedRef.current?.(created);
    setBusy(false);
    await loadPreview(created);
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

  /**
   * 409 後的採納：改為追蹤「他方／先行啟動的那一輪」（見 `IndexPollGate` 的採納模式）。
   *
   * 為什麼需要：`POST /index` 回 409 的語意是「你要的那一輪已經存在、正在跑」——不是失敗。
   * preflight（`beginIndex` 發 POST 前的 GET）取到的 baseline 恰好就是那一輪（他方先啟動，
   * `runSeq` 較新）；若仍以它為 baseline，gate 會把那一輪的**終態**當成「要忽略的舊輪殘留」
   * 而一路等到寬限 → 明明該輪已正常結束，UI 卻顯示「無法確認」（`stalled`）。
   *
   * 做法：同步補一次 `getIndexStatus`（catch 包住），以**當下那一輪的 `runSeq`** 建採納型 gate。
   * 若該輪已進終態（409 與結束之間的窄窗），採納值就是該終態的 `runSeq`，gate 下一次 `observe`
   * 立刻判 `terminal`，直接顯示結果。取不到狀態時退回 `"unknown"`（不誤判、等寬限），
   * 與 preflight 的兜底一致。
   */
  const adoptRunningRound = async (): Promise<void> => {
    if (root === null) return;
    const track: PollTrack = await getIndexStatus(root.id)
      .then((snapshot): PollTrack => (snapshot.runSeq === null ? "unknown" : { adopt: snapshot.runSeq }))
      .catch((): PollTrack => "unknown");
    pollGateRef.current = new IndexPollGate(track, POLL_INTERVAL_MS);
  };

  const beginIndex = async (): Promise<void> => {
    if (root === null) return;
    // 同步防重入（在任何 await 之前）：快速雙擊的第二次呼叫直接返回，不送出第二份 POST。
    if (indexStartingRef.current) return;
    indexStartingRef.current = true;
    try {
      setError(null);
      setStalled(false);
      cancelRequestedRef.current = false;
      setCancelling(false);
      // 先**同步**完成 UI 轉場：控制項（「開始索引」／「重新索引」／「重試」）立刻消失，
      // 不給使用者再點的機會；同時讓輪詢 effect 以 "unknown" 模式起跑（baseline 尚未定案）。
      setStep("indexing");
      pollGateRef.current = new IndexPollGate("unknown", POLL_INTERVAL_MS);
      // W1：baseline 在發 POST **之前**以一次 GET 取得（新 root 為 null，天然正確）；
      // 若沿用 React state 的 `status?.runSeq`，狀態尚未載入時為 null，而既有 root 可能有
      // runSeq=1，gate 會把舊輪終態誤判成本輪結束而停止輪詢。此 GET 先於 POST，無競態。
      // 取不到時**一步**退成 "unknown"（不重試）：本輪真的啟動後就會出現 running 或新終態，
      // unknown 模式據此仍能正確收斂，足以消解這種暫時性失敗（見 `PollBaseline`）。
      const baseline: PollBaseline = await getIndexStatus(root.id)
        .then((snapshot) => snapshot.runSeq ?? null)
        .catch((): PollBaseline => "unknown");
      // baseline 定案：以正確值重建 gate（若期間輪詢已跑過，換上新 gate 後即用正確判準）。
      pollGateRef.current = new IndexPollGate(baseline, POLL_INTERVAL_MS);
      // 不 await：POST /index 會等索引跑完才回應，進度靠輪詢。
      void startIndex(root.id).catch((indexError: unknown) => {
        // 使用者主動取消時 POST /index 也會結束（伺服器回 200），不該顯示成失敗。
        if (cancelRequestedRef.current) return;
        // 縱深防禦：單一工作模型下 409 代表「同一 root 已有一輪索引在跑」，不是失敗。
        // 若輪詢門控仍在推進（流程還停在 indexing），改為**追蹤那一輪**（採納型 gate）；
        // 仍以 preflight 的 baseline 判斷會把那一輪的終態誤當成殘留舊輪、等到寬限顯示 stalled
        // （見 `adoptRunningRound` 與 `IndexPollGate` 的採納模式）。
        if (isIndexAlreadyRunningError(indexError) && stepRef.current === "indexing") {
          void adoptRunningRound();
          return;
        }
        setError(indexError instanceof Error ? indexError.message : "索引失敗");
        setStep("failed");
      });
    } finally {
      indexStartingRef.current = false;
    }
  };

  /**
   * 要求取消進行中的索引。
   *
   * 伺服器回 404（取消請求比索引註冊更早到達）**不當成已取消**，改走短重試窗口
   * （見 `cancelIndexWithRetry`）；窗口期間維持「取消中…」。窗口結束後重讀狀態：
   * 若這輪索引從未啟動（仍是 idle），回到可重試畫面，不讓 UI 卡在「索引中」；
   * 若已在終態，則由輪詢接手切換步驟。
   */
  const requestCancel = async (): Promise<void> => {
    if (root === null || cancelling) return;
    cancelRequestedRef.current = true;
    setCancelling(true);
    try {
      const outcome = await cancelIndexWithRetry(root.id);
      const current = await getIndexStatus(root.id);
      setStatus(current);
      if (outcome === "finished" && current.state === "idle") {
        // 窗口內都沒觀察到本輪：POST 從未成功啟動，沒有可取消的對象。
        cancelRequestedRef.current = false;
        setError("索引沒有開始（可能是請求失敗），請重試。");
        setStep("failed");
      }
    } catch (cancelError) {
      // 取消失敗（例如連線中斷）：回到可重試的索引中畫面，讓輪詢繼續。
      cancelRequestedRef.current = false;
      setError(cancelError instanceof Error ? cancelError.message : "取消索引失敗");
    } finally {
      setCancelling(false);
    }
  };

  // 索引中：每 POLL_INTERVAL_MS 輪詢一次狀態，直到**本輪**到達終態（見 IndexPollGate）。
  useEffect(() => {
    if (step !== "indexing" || root === null) return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const current = await getIndexStatus(root.id);
        if (cancelled) return;
        setStatus(current);
        // 每次 tick 都讀 ref：preflight 定案後 `beginIndex` 會換上帶正確 baseline 的新 gate，
        // 這裡立即生效（不必重啟 effect）。
        const outcome = pollGateRef.current.observe(current);
        if (outcome.kind === "continue") return;
        if (outcome.kind === "stalled") {
          // 寬限用盡仍沒看到本輪：「可能只是註冊較慢」，不直接當成最終失敗；
          // 以可恢復措辭呈現（`stalled` 讓 `failed` 步驟改顯示提示而非「索引失敗」）。
          setStalled(true);
          setError("尚未偵測到索引啟動，可能是註冊較慢或請求失敗；請按「重試」再試一次。");
          setStep("failed");
          return;
        }
        if (current.state === "completed") {
          setStep("done");
          onDoneRef.current(root);
        } else if (current.state === "cancelled") {
          setStep("cancelled");
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
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
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
          <ImagesToggle checked={includeImages} onChange={setIncludeImages} />
          <AudioToggle checked={includeAudio} disabled={busy} onChange={setIncludeAudio} />
          <VideoToggle
            checked={includeVideo}
            disabled={busy || !videoToggle.enabled}
            state={videoToggle}
            onChange={setIncludeVideo}
          />
          <div className="space-y-1">
            <label htmlFor="add-root-video-limit" className="block text-sm font-medium text-ink">
              影片單檔大小上限（MiB）
            </label>
            <div className="flex items-center gap-2">
              <input
                id="add-root-video-limit"
                type="number"
                min={VIDEO_LIMIT_MIN_MIB}
                max={VIDEO_LIMIT_MAX_MIB}
                step={1}
                inputMode="numeric"
                value={videoLimitMiB}
                disabled={busy}
                aria-invalid={!videoLimit.ok}
                aria-describedby="add-root-video-limit-hint"
                onChange={(event) => setVideoLimitMiB(event.target.value)}
                className="w-32 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-ink disabled:opacity-40"
              />
              <span className="text-sm text-muted">MiB</span>
            </div>
            <p id="add-root-video-limit-hint" className="text-xs text-muted">
              預設 512 MiB（目前服務預設：{formatVideoLimitBytes(videoCapability?.maxFileBytes ?? DEFAULT_VIDEO_MAX_FILE_BYTES)}）。
              只套用影片；影片未開啟也可以先設定，上限 16 GiB。超過這個大小的影片會具名跳過。
            </p>
            {!videoLimit.ok && (
              <p role="alert" className="text-xs text-red-600">
                {videoLimit.message}
              </p>
            )}
          </div>
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

          <ImagesToggle
            checked={includeImages}
            disabled={busy}
            onChange={(next) => void setImagesEnabled(next)}
          />
          <AudioToggle checked={includeAudio} disabled={busy} onChange={(next) => void setAudioEnabled(next)} />
          <VideoToggle
            checked={includeVideo}
            disabled={busy || !videoToggle.enabled}
            state={videoToggle}
            onChange={(next) => void setVideoEnabled(next)}
          />
          <p className="text-xs text-muted">
            影片單檔上限：{formatVideoLimitBytes(effectiveVideoMaxFileBytes(root, videoCapability?.maxFileBytes))}
            {root.videoMaxFileBytes == null ? "（服務預設）" : ""}
            ；加入後可在左側資料夾清單修改（只套用影片，不需要重新索引既有文字／圖片）。
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="檔案數" value={String(preview.totalFiles)} />
            <Stat label="總大小" value={formatBytes(preview.totalBytes)} />
            <Stat label="預估索引量" value={`${preview.estimatedChunks} 塊`} />
            <Stat label="預估時間" value={`約 ${preview.estimatedSeconds} 秒`} />
          </div>

          {preview.estimated !== undefined && (
            <p className="text-xs text-muted">
              時間組成（粗估）：文字 {preview.estimated.textSeconds} 秒、圖片 {preview.estimated.imageSeconds} 秒
              {preview.estimated.otherSeconds > 0 ? `、其他媒體 ${preview.estimated.otherSeconds} 秒` : ""}。
              單張照片約數秒；沒勾「含照片」時圖片會列在下面的「未開啟的模態」被跳過。
              {includeAudio && " 音訊依檔案大小估算片段上界，尚未讀取實際時長；不含首次模型下載時間。"}
              {preview.video !== null && preview.video !== undefined && preview.video.files > 0 &&
                " 影片的時長與段數在預覽階段未知，不計入上面的估時（見下方影片區塊）。"}
            </p>
          )}

          {preview.video !== null && preview.video !== undefined && preview.video.files > 0 && (
            <VideoCandidates
              video={preview.video}
              skipped={preview.skipped}
              durationLimitSeconds={videoCapability?.durationLimitSeconds ?? VIDEO_MAX_DURATION_SECONDS}
              maxFileBytes={effectiveVideoMaxFileBytes(root, videoCapability?.maxFileBytes)}
            />
          )}

          {!includeVideo && preview.skipped.some((item) => item.reason === "modality-off") && (
            <p className="text-xs text-muted">
              影片（與其他未開啟的模態）目前不列入候選；若這個資料夾含 .mp4，勾選「含影片」後會重新預覽候選數。
            </p>
          )}

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
                    {isVideoReason(item.reason)
                      ? videoReasonLabel(item.reason)
                      : (SKIP_REASON_LABEL[item.reason] ?? item.reason)}：{item.count} 個
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
              onClick={() => void beginIndex()}
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

      {step === "preview-failed" && root !== null && (
        <div className="space-y-3">
          <p className="break-all font-mono text-xs text-muted">{root.path}</p>
          <p role="alert" className="text-sm text-red-600">
            {error ?? "讀取預覽統計失敗"}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void loadPreview(root)}
              disabled={busy}
              className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "重試中…" : "重試預覽"}
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
          {includeAudio && <AudioModelStatus active />}
          <ProgressBar status={status} />
          {error !== null && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void requestCancel()}
            disabled={cancelling}
            className="rounded-md border border-line px-3 py-2 text-sm text-ink disabled:opacity-40"
          >
            {cancelling ? "取消中…" : "取消索引"}
          </button>
        </div>
      )}

      {step === "cancelled" && (
        <div className="space-y-3">
          <p className="text-sm text-ink">已取消索引。已完成的檔案仍保留在索引中，可隨時重新索引。</p>
          <ProgressBar status={status} />
          <div className="flex gap-2">
            {root !== null && (
              <button
                type="button"
                onClick={() => void beginIndex()}
                className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-white"
              >
                重新索引
              </button>
            )}
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-line px-3 py-2 text-sm text-ink"
            >
              關閉
            </button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="space-y-2">
          <p className="text-sm text-ink">索引完成，目錄樹已可使用。</p>
          {includeAudio && <AudioModelStatus />}
          {status?.state === "completed" && status.result !== null && describeVideoEntries(status.result.failedFiles) !== "" && (
            <p className="text-xs text-amber-700">
              部分影片處理失敗（其餘檔案已完成）：{describeVideoEntries(status.result.failedFiles)}。
            </p>
          )}
        </div>
      )}

      {step === "failed" && (
        <div className="space-y-3">
          {stalled ? (
            // stalled：可能只是註冊較慢，不當成最終失敗；用可恢復措辭（與 ExplorerPanel 對稱）。
            <p role="status" className="text-sm text-amber-700">
              {error ?? "尚未偵測到索引啟動，請按「重試」再試一次。"}
            </p>
          ) : (
            <p role="alert" className="text-sm text-red-600">
              索引失敗：{error ?? "未知錯誤"}
            </p>
          )}
          {root !== null && (
            <button
              type="button"
              onClick={() => void beginIndex()}
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

/**
 * 「這個資料夾含照片，一起索引」開關（加入前與預覽頁共用同一個控制項）。
 *
 * 標籤刻意用白話（不寫「image 模態」），並在同一行說明代價與「改完要重新索引才生效」。
 */
function AudioToggle({ checked, disabled, onChange }: {
  checked: boolean; disabled?: boolean; onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-ink">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-0.5" />
      <span>這個資料夾含音訊，一起索引
        <span className="mt-0.5 block text-xs text-muted">支援 WAV（PCM16／float32、單／雙聲道），預設單檔最多 10 MiB、最長 10 分鐘。首次索引需下載音訊模型；檔案內容只在本機處理。預覽依檔名與大小統計，格式與時長於索引時確認。</span>
      </span>
    </label>
  );
}

/**
 * 「這個資料夾含影片，一起索引」開關（加入前與預覽頁共用）。
 *
 * 服務層影片能力不可用時停用並顯示原因（decoder 缺失／損毀／embedder 不支援），
 * 不讓使用者開了之後才發現索引時全數失敗。預設關閉。
 */
function VideoToggle({ checked, disabled, state, onChange }: {
  checked: boolean;
  disabled?: boolean;
  state: { enabled: boolean; reason: string | null; summary: string };
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-ink">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled ?? !state.enabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span>
        這個資料夾含影片（.mp4），一起索引
        <span className="mt-0.5 block text-xs text-muted">
          每 {VIDEO_SEGMENT_SECONDS} 秒抽 1 幀（短暫畫面可能被略過）；預覽不讀媒體，時長與段數待確認。
          同時開啟「含音訊」才會索引影片的選定 AAC 音軌。{state.summary}
          {state.reason !== null ? `（${state.reason}）` : ""}
        </span>
      </span>
    </label>
  );
}

/**
 * 預覽頁的影片候選區塊：候選檔數、時長待確認、抽樣限制、上限與上界段數、影片 skip 原因。
 *
 * 所有數字都標明是**上界**；不把「壓縮大小 ÷ 位元率」之類的推算畫成時長。
 */
function VideoCandidates({ video, skipped, durationLimitSeconds, maxFileBytes }: {
  video: VideoPreviewEstimate;
  skipped: RootPreview["skipped"];
  durationLimitSeconds: number;
  maxFileBytes: number;
}) {
  const videoSkipped = skipSummary(skipped.filter((item) => isVideoReason(item.reason)));
  return (
    <div className="space-y-1 rounded-md border border-line bg-surface px-3 py-2 text-xs text-muted">
      <p className="text-sm font-medium text-ink">影片候選：{video.files} 支</p>
      <p>時長待確認：預覽只列舉與估算，不讀取媒體、不啟動 probe，也不由壓縮大小換算秒數。</p>
      <p>
        抽樣限制：每 {VIDEO_SEGMENT_SECONDS} 秒一段、每段 1 幀（約 0.25 fps）；短暫事件可能被抽樣略過，
        命中時間代表片段時間。
      </p>
      <p>
        上限：時長 {formatVideoLimitSeconds(durationLimitSeconds)} 秒、單檔 {formatVideoLimitBytes(maxFileBytes)}；
        超過的檔案會具名跳過，不會索引部分內容。
      </p>
      <p>
        索引段數上界：{video.estimatedSegmentCountMax} 段（每檔畫面最多 {video.visualSegmentsPerFileMax} 段
        {video.includesAudioTrack ? `、音軌最多 ${video.audioSegmentsPerFileMax} 段` : ""}）；
        索引時間上界約 {video.estimatedSecondsMax} 秒。這些都是上界，不是實際值。
      </p>
      <p>
        音軌：{video.includesAudioTrack
          ? "已計入影片的選定 AAC 音軌（每 10 秒一段）；只有選定音軌缺失或不支援時整檔具名跳過。"
          : "未計入影片音軌（需同時勾選「含音訊」；只有音訊開關不會讀取影片）。"}
      </p>
      {videoSkipped.length > 0 && (
        <p>
          因影片限制被跳過：
          {videoSkipped.map((item) => `${videoReasonLabel(item.reason)} ${item.count} 個`).join("、")}。
        </p>
      )}
    </div>
  );
}

function ImagesToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-ink">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled ?? false}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span>
        這個資料夾含照片，一起索引
        <span className="mt-0.5 block text-xs text-muted">
          照片索引比文字慢很多（每張約數秒）。之後可以隨時關閉；改變設定後要重新索引才會生效。
        </span>
      </span>
    </label>
  );
}

/**
 * 索引进度：長條圖以**檔案**為單位（單調不倒退），文字另外顯示 chunk 級資訊。
 *
 * 為什麼長條圖不用 chunk 數：`estimatedChunks` 是逐檔切塊後累加的**下界**，大檔開始時
 * 會先跳高，用 chunk 比例畫長條圖會讓百分比倒退。chunk 數放在文字裡，讓使用者在大檔
 * 進行中看到規模（例如「已嵌入 0／預估 8,800 塊」），而不是只有不動的檔案數。
 */
function ProgressBar({ status }: { status: IndexStatus | null }) {
  const progress = status?.progress ?? null;
  const total = progress?.total ?? 0;
  const done = (progress?.processed ?? 0) + (progress?.skippedUnchanged ?? 0) + (progress?.skipped ?? 0) + (progress?.failed ?? 0);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const chunkLine =
    progress !== null && progress.estimatedChunks > 0
      ? `；已嵌入 ${progress.processedChunks}／預估 ${progress.estimatedChunks} 塊`
      : "";

  return (
    <div className="space-y-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-line">
        <div className="h-full bg-ink transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-xs text-muted">
        {total > 0
          ? `已處理 ${progress?.processed ?? 0}／${total} 個檔案（${percent}%），跳過未變更 ${progress?.skippedUnchanged ?? 0} 個${chunkLine}`
          : "正在掃描檔案…"}
      </p>
      {progress !== null && progress.failed > 0 && (
        <p className="text-xs text-amber-700">有 {progress.failed} 個檔案處理失敗，其餘仍會繼續。</p>
      )}
    </div>
  );
}
