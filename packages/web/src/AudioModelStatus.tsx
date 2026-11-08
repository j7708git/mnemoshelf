import { useEffect, useState } from "react";
import { fetchDiagnostics } from "./api";

/** 執行中持續更新，完成後保留一次狀態查詢，讓失敗仍可被看見。 */
export function AudioModelStatus({ active = false }: { active?: boolean }) {
  const [message, setMessage] = useState("正在確認音訊模型狀態…");
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const status = await fetchDiagnostics();
        if (!cancelled) {
          const state = status.embedderRuntime?.audioState;
          setMessage(!status.embedder.capabilities.audio ? "目前模型不支援音訊。" :
            state === "loading" ? "正在準備音訊模型；首次使用可能需要下載，請保持網路連線。" :
            state === "failed" ? (status.embedderRuntime?.audioRetryable === false
              ? "音訊模型初始化失敗，請重新啟動應用程式後再試。"
              : "音訊模型準備失敗；請檢查連線與索引錯誤，完成後可重新索引。") :
            state === "ready" ? "音訊模型已就緒，音訊內容在本機處理。" : "音訊模型將在處理第一個音訊片段時載入。");
        }
      } catch {
        if (!cancelled) setMessage("暫時無法取得音訊模型狀態，索引進度仍會持續更新。");
      } finally {
        if (!cancelled && active) timer = setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active]);
  return <p role="status" className="text-xs text-muted">{message}</p>;
}
