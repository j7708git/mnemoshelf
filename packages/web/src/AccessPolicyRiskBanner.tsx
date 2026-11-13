/**
 * 存取策略放寬警告橫幅：只要服務設定偏離安全預設（非 loopback、匿名免 token、
 * 放寬瀏覽範圍、關閉敏感路徑黑名單），就明確提示使用者風險並標示放寬項目。
 */
import type { BrowseAccessPolicy } from "./api";

export function describeRelaxedPolicyReasons(policy: BrowseAccessPolicy): string[] {
  const reasons: string[] = [];
  if (policy.nonLoopbackBind) {
    reasons.push(`綁定位址為 ${policy.host}（已開放本機 loopback 以外的網路連線）`);
  }
  if (policy.allowAnonymous) {
    reasons.push("已停用 token 驗證（允許匿名存取 API 與瀏覽資料夾）");
  }
  if (policy.browseScope === "unrestricted") {
    reasons.push("資料夾瀏覽範圍為不限（可瀏覽家目錄以外的系統路徑）");
  } else if (policy.browseScope === "custom") {
    reasons.push("資料夾瀏覽範圍為自訂目錄（可能涵蓋家目錄以外的路徑）");
  }
  if (!policy.respectBlacklist) {
    reasons.push("已停用敏感路徑黑名單（瀏覽時不再隱藏金鑰／系統敏感目錄）");
  }
  return reasons;
}

export interface AccessPolicyRiskBannerProps {
  policy: BrowseAccessPolicy | null | undefined;
  compact?: boolean;
}

export function AccessPolicyRiskBanner({ policy, compact = false }: AccessPolicyRiskBannerProps) {
  if (policy === null || policy === undefined || !policy.relaxed) return null;
  const reasons = describeRelaxedPolicyReasons(policy);
  if (reasons.length === 0) return null;

  return (
    <div
      role="status"
      data-testid="access-policy-risk-banner"
      className={`rounded-[14px] border border-warn-line bg-warn-bg text-warn ${
        compact ? "px-3.5 py-2 text-xs" : "px-4 py-3 text-xs"
      }`}
    >
      <p className="font-semibold">
        注意：目前伺服器的預設安全限制已被放寬，相關存取風險由使用者自行承擔
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}
