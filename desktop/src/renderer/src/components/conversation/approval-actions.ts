import { browserCanonicalDecision, type BrowserPermissionChoice } from "@matrix-os/contracts";
import type { ConversationActionPresentation, ConversationPresentationCallbacks } from "./presentation";

type ApprovalAction = Extract<ConversationActionPresentation, { kind: "approval" }>;

/**
 * The approval action a card button may send: only one the request offers, and only when this
 * viewer may act on it (the same gate as the generic request view). Never invents a decision.
 */
export function offeredApprovalAction(
  request: { actions?: readonly ConversationActionPresentation[] },
  callbacks: Pick<ConversationPresentationCallbacks, "performAction" | "canPerformAction">,
  decision: ApprovalAction["decision"],
): ApprovalAction | null {
  if (!callbacks.performAction) return null;
  const action = (request.actions ?? []).find((candidate): candidate is ApprovalAction => (
    candidate.kind === "approval" && candidate.decision === decision
  ));
  if (!action || (callbacks.canPerformAction && !callbacks.canPerformAction(action))) return null;
  return action;
}

/** Keep browser choice provenance while applying the same offered-action/viewer gate. */
export function offeredBrowserApprovalAction(
  request: { actions?: readonly ConversationActionPresentation[] },
  callbacks: Pick<ConversationPresentationCallbacks, "performAction" | "canPerformAction">,
  choice: BrowserPermissionChoice,
): ApprovalAction | null {
  const action = offeredApprovalAction(request, callbacks, browserCanonicalDecision(choice));
  return action ? { ...action, browserChoice: choice } : null;
}
