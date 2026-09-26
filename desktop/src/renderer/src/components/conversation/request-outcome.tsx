import { canonicalChatApprovalOutcome } from "@matrix-os/contracts";
import { CheckCircle2, MessageCircle, ShieldAlert } from "@renderer/lib/hugeicons";
import type { ConversationRequestPresentation } from "./presentation";

function approved(request: ConversationRequestPresentation): boolean {
  return request.decision === "approve" || request.decision === "approve_for_session";
}

export function RequestStatusIcon({ request }: { request: ConversationRequestPresentation }) {
  const success = request.state === "resolved" && (request.requestKind !== "approval" || approved(request));
  const Icon = success ? CheckCircle2 : request.requestKind === "approval" ? ShieldAlert : MessageCircle;
  return <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: success ? "var(--success)" : "var(--text-secondary)" }} />;
}

export function RequestApprovalOutcome({ request }: { request: ConversationRequestPresentation }) {
  if (request.requestKind !== "approval" || request.state !== "resolved") return null;
  return <p className="mt-1 text-sm" style={{ color: approved(request) ? "var(--success)" : "var(--text-secondary)" }}>
    {canonicalChatApprovalOutcome(request.decision)}
  </p>;
}
