import { CanonicalSubmitChatApprovalRequestSchema, type CanonicalSubmitChatApprovalRequest } from "#canonical-chat-api";
import { browserCanonicalDecision, BrowserGrantRevokeRequestSchema, BrowserGrantViewSchema, type BrowserGrantView, type BrowserApprovalIntentSchema } from "#browser-chat-approval";
import type { CanonicalChatApprovalView } from "#canonical-chat-approvals";
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
export function browserPermissionOutcome(approval: CanonicalChatApprovalView, now = Date.now(), submitted = false): string {
  const browser = approval.browserApproval;
  if (approval.pending && browser && !browser.resolution && Date.parse(browser.expiresAt) > now) return submitted
    ? "Decision submitted. Waiting for confirmation." : "Waiting for your approval";
  const resolution = browser?.resolution ?? (browser && !(Date.parse(browser.expiresAt) > now) ? "expired" : "interrupted");
  return ({ allowed_once: "Allowed once", allowed_in_chat: "Allowed in this Chat", declined: "Not now · browser action skipped",
    cancelled: "Browser action cancelled", expired: "Request expired · ask the agent to try again", interrupted: "Browser action interrupted" })[resolution];
}

/** A confirmed revocation survives missing or older observations of that grant.
 * A newer revision still permits a later, intentional grant in this Chat. */
export function reconcileBrowserGrantObservation(prior: BrowserGrantView | null, fresh: BrowserGrantView | null, chatId: string): BrowserGrantView | null {
  const previous = prior?.chatId === chatId ? prior : null;
  if (!fresh || fresh.chatId !== chatId) return previous?.state === "revoked" ? previous : null;
  return previous?.id === fresh.id && previous.revision >= fresh.revision ? previous : fresh;
}

/** Never log upstream messages, request bodies or arbitrary error names. */
export function browserPermissionErrorKind(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return ["Error", "TypeError", "AbortError", "TimeoutError", "ZodError"].includes(error.name) ? error.name : "RequestError";
}

/** One bounded uncertain Undo attempt. Retain its identity until the exact
 * grant revision changes; the owner repository can replay a lost response. */
export function createBrowserGrantUndoTracker() {
  let attempt: { key: string; clientRequestId: string } | undefined;
  return { request(value: BrowserGrantView, createId: () => string) {
    const grant = BrowserGrantViewSchema.parse(value);
    if (grant.state !== "active") throw new Error("Browser access unavailable");
    const key = `${grant.chatId}\0${grant.id}\0${grant.revision}`;
    if (!attempt || attempt.key !== key) attempt = { key, clientRequestId: createId() };
    return BrowserGrantRevokeRequestSchema.parse({ clientRequestId: attempt.clientRequestId, baseRevision: grant.revision });
  } };
}
