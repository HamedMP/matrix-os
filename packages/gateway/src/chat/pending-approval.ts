import type { CanonicalChatRunActivity } from "@matrix-os/contracts";

type RequestedApproval = Extract<CanonicalChatRunActivity, { type: "approval.requested" }>;

/** A resolved Allow in this chat can still be declined until Undo records session_revoked. */
export function selectPendingApproval(
  activities: readonly CanonicalChatRunActivity[],
  approvalId: string,
): RequestedApproval | null {
  let pending: RequestedApproval | null = null;
  let sessionGrant = false;
  for (const activity of activities) {
    if (activity.type !== "approval.requested" && activity.type !== "approval.resolved") continue;
    if (activity.approvalId !== approvalId) continue;
    if (activity.type === "approval.requested") {
      pending = activity;
      sessionGrant = false;
      continue;
    }
    sessionGrant = activity.decision === "approve_for_session" && activity.reason !== "session_revoked";
    if (!sessionGrant) pending = null;
  }
  if (!pending) return null;
  return sessionGrant ? { ...pending, allowedDecisions: ["decline"] } : pending;
}
