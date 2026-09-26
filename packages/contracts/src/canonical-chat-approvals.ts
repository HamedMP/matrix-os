import type { CanonicalChatDetailResponse } from "./canonical-chat-api.js";
import type { CanonicalChatApprovalDecision } from "./canonical-chat.js";
import { canonicalChatApprovalDisplay } from "./canonical-chat-approval-display.js";
export { canonicalChatApprovalOutcome } from "./canonical-chat-approval-display.js";

export interface CanonicalChatApprovalView {
  id: string;
  runId: string;
  approvalId: string;
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  allowedDecisions: CanonicalChatApprovalDecision[];
  pending: boolean;
  decision?: CanonicalChatApprovalDecision;
  timestamp: number;
  beforeMessageId?: string;
}

/** One run-scoped approval model for legacy message parts and native activities.
 * Collections are request-local and bounded by the detail response schema.
 * Terminal runs fence stale history even when an older runner lost resolution.
 */
export function canonicalChatApprovals(detail: Pick<CanonicalChatDetailResponse, "runs" | "turns" | "messages" | "activities">): CanonicalChatApprovalView[] {
  const approvals = new Map<string, CanonicalChatApprovalView>();
  const resolved = new Map<string, CanonicalChatApprovalDecision>();
  const key = (runId: string, approvalId: string) => `${runId}\0${approvalId}`;
  for (const message of detail.messages) {
    if (!message.runId) continue;
    for (const part of message.parts) {
      if (part.type === "approval_result") resolved.set(key(message.runId, part.approvalId), part.decision);
      if (part.type !== "approval_request") continue;
      approvals.set(key(message.runId, part.approvalId), {
        ...part, ...canonicalChatApprovalDisplay(part.title, part.description), id: message.id, runId: message.runId,
        pending: false, timestamp: Date.parse(message.createdAt),
      });
    }
  }
  for (const activity of detail.activities) {
    if (activity.type === "approval.resolved") resolved.set(key(activity.runId, activity.approvalId), activity.decision);
    if (activity.type !== "approval.requested") continue;
    const identity = key(activity.runId, activity.approvalId);
    if (approvals.has(identity)) continue;
    approvals.set(identity, {
      id: activity.id, runId: activity.runId, approvalId: activity.approvalId,
      ...canonicalChatApprovalDisplay(activity.title, activity.safeDescription ?? "The agent is waiting for your decision."),
      risk: activity.risk, allowedDecisions: activity.allowedDecisions,
      pending: false, timestamp: Date.parse(activity.occurredAt),
    });
  }
  return [...approvals.entries()].flatMap(([identity, approval]) => {
    const run = detail.runs.find(r => r.id === approval.runId);
    if (!run) return [];
    const turn = detail.turns.find(t => t.id === run.turnId);
    const input = detail.messages.find(m => m.id === turn?.inputMessageId);
    const next = input && detail.messages.find(m => m.role === "user" && m.seq > input.seq && m.turnId !== run.turnId);
    return [{ ...approval,
      ...(resolved.has(identity) ? { decision: resolved.get(identity) } : {}),
      pending: ["accepted", "running", "waiting_for_approval", "waiting_for_input"].includes(run.status)
        && !resolved.has(identity),
      ...(next ? { beforeMessageId: next.id } : {}),
    }];
  });
}
