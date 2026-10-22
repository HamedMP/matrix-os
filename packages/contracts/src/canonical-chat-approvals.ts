import type { CanonicalChatDetailResponse } from "./canonical-chat-api.js";
import type { z } from "zod/v4";
import type { BrowserApprovalLifecycleSchema, BrowserGrantView } from "./browser-chat-approval.js";
import type { CanonicalChatApprovalDecision } from "./canonical-chat.js";
import { canonicalChatApprovalDisplay } from "#canonical-chat-approval-display";
import { canonicalSafeLabel } from "#canonical-chat-primitives";
export { canonicalChatApprovalOutcome } from "#canonical-chat-approval-display";

const ApprovalTitleSchema = canonicalSafeLabel(160, 640);
/** Match persisted approval title safety without altering execution arguments. */
export function canonicalChatApprovalTitle(value: string): string {
  const parsed = ApprovalTitleSchema.safeParse(value);
  return parsed.success ? parsed.data : "Review integration request";
}

export interface CanonicalChatApprovalView {
  id: string;
  runId: string;
  approvalId: string;
  actionDigest?: string;
  browserApproval?: z.infer<typeof BrowserApprovalLifecycleSchema>;
  browserGrant?: BrowserGrantView;
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  allowedDecisions: CanonicalChatApprovalDecision[];
  pending: boolean;
  decision?: CanonicalChatApprovalDecision;
  reason?: "expired";
  timestamp: number;
  beforeMessageId?: string;
}

/** One run-scoped approval model for legacy message parts and native activities.
 * Collections are request-local and bounded by the detail response schema.
 * Terminal runs fence stale history even when an older runner lost resolution.
 */
export function canonicalChatApprovals(detail: Pick<CanonicalChatDetailResponse, "runs" | "turns" | "messages" | "activities">, now = Date.now()): CanonicalChatApprovalView[] {
  const approvals = new Map<string, CanonicalChatApprovalView>();
  const resolved = new Map<string, { decision: CanonicalChatApprovalDecision; reason?: "expired" }>();
  const browserResolved = new Map<string, { browserApproval?: z.infer<typeof BrowserApprovalLifecycleSchema>; browserGrant?: BrowserGrantView }>();
  const key = (runId: string, approvalId: string) => `${runId}\0${approvalId}`;
  for (const message of detail.messages) {
    if (!message.runId) continue;
    for (const part of message.parts) {
      if (part.type === "approval_result") resolved.set(key(message.runId, part.approvalId), { decision: part.decision });
      if (part.type !== "approval_request") continue;
      approvals.set(key(message.runId, part.approvalId), {
        ...part, ...canonicalChatApprovalDisplay(part.title, part.description), id: message.id, runId: message.runId,
        pending: false, timestamp: Date.parse(message.createdAt),
      });
    }
  }
  for (const activity of detail.activities) {
    if (activity.type === "approval.resolved") {
      const identity = key(activity.runId, activity.approvalId);
      resolved.set(identity, { decision: activity.decision, ...(activity.reason ? { reason: activity.reason } : {}) });
      if (activity.browserApproval) browserResolved.set(identity, { browserApproval: activity.browserApproval, browserGrant: activity.browserGrant });
    }
    if (activity.type !== "approval.requested") continue;
    const identity = key(activity.runId, activity.approvalId);
    const existing = approvals.get(identity);
    if (existing) {
      if (activity.browserApproval) existing.browserApproval = activity.browserApproval;
      if (!existing.actionDigest && activity.actionDigest) existing.actionDigest = activity.actionDigest;
      continue;
    }
    approvals.set(identity, {
      id: activity.id, runId: activity.runId, approvalId: activity.approvalId,
      ...(activity.actionDigest ? { actionDigest: activity.actionDigest } : {}),
      ...canonicalChatApprovalDisplay(activity.title, activity.safeDescription ?? "The agent is waiting for your decision."),
      ...(activity.browserApproval ? { browserApproval: activity.browserApproval } : {}),
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
    const outcome = resolved.get(identity);
    const browser = browserResolved.get(identity)?.browserApproval ?? approval.browserApproval;
    const active = ["accepted", "running", "waiting_for_approval", "waiting_for_input"].includes(run.status);
    const expired = browser && !browser.resolution && !(Date.parse(browser.expiresAt) > now);
    const lifecycle = browser && { ...browser, ...(expired ? { resolution: "expired" as const } : !active && !browser.resolution ? { resolution: "interrupted" as const } : {}) };
    return [{ ...approval, ...browserResolved.get(identity), ...(lifecycle ? { browserApproval: lifecycle } : {}),
      ...(outcome ? { decision: outcome.decision, ...(outcome.reason ? { reason: outcome.reason } : {}) } : {}),
      pending: active && !resolved.has(identity) && !lifecycle?.resolution,
      ...(next ? { beforeMessageId: next.id } : {}),
    }];
  });
}
