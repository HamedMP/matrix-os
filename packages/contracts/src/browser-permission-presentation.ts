import { CanonicalSubmitChatApprovalRequestSchema, type CanonicalSubmitChatApprovalRequest } from "./canonical-chat-api.js";
import { browserCanonicalDecision, type BrowserApprovalIntentSchema } from "./browser-chat-approval.js";
import type { CanonicalChatApprovalView } from "./canonical-chat-approvals.js";
import type { z } from "zod/v4";

export type BrowserPermissionChoice = z.infer<typeof BrowserApprovalIntentSchema>["decision"];
export const browserPermissionChoices = [
  { decision: "allow_once", label: "Allow once" },
  { decision: "allow_in_chat", label: "Allow in this Chat" },
  { decision: "not_now", label: "Not now" },
] as const;
export function browserPermissionRequest(approval: CanonicalChatApprovalView | undefined, choice: BrowserPermissionChoice,
  clientRequestId: string, now = Date.now()): CanonicalSubmitChatApprovalRequest {
  const browser = approval?.browserApproval;
  if (!approval?.pending || !browser || browser.resolution || !(Date.parse(browser.expiresAt) > now)) throw new Error("Approval unavailable");
  return CanonicalSubmitChatApprovalRequestSchema.parse({ clientRequestId, decision: browserCanonicalDecision(choice),
    actionDigest: approval.actionDigest, browserApproval: { kind: browser.kind, decision: choice, leaseEpoch: browser.leaseEpoch,
      challengeRevision: browser.challengeRevision, scopeVersion: browser.scopeVersion } });
}
export function browserPermissionOutcome(approval: CanonicalChatApprovalView, now = Date.now()): string {
  const browser = approval.browserApproval;
  if (approval.pending && browser && !browser.resolution && Date.parse(browser.expiresAt) > now) return "Waiting for your approval";
  const resolution = browser?.resolution ?? (browser && !(Date.parse(browser.expiresAt) > now) ? "expired" : "interrupted");
  return ({ allowed_once: "Allowed once", allowed_in_chat: "Allowed in this Chat", declined: "Not now · browser action skipped",
    cancelled: "Browser action cancelled", expired: "Request expired · ask the agent to try again", interrupted: "Browser action interrupted" })[resolution];
}
