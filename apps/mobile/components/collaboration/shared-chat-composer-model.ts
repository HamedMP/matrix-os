import type { CollaborationAiRequest, CollaborationScope } from "@matrix-os/contracts/collaboration";
import type { SharedChatComposerState } from "./SharedChatComposer";

export function deriveSharedChatComposerPresentation(state: SharedChatComposerState) {
  const viewer = state.scope?.role === "viewer";
  const aiAvailable = state.aiAvailability === "available";
  const canRequestAi = !viewer && aiAvailable && state.scope?.lifecycle === "shared"
    && state.scope.capabilities.requestAi;
  const canWrite = canRequestAi;
  const value = state.aiDraft;
  const status = viewer
    ? "Viewers can read this Chat but cannot send messages."
    : state.aiAvailability === "checking" ? "Connecting to Matrix…"
      : aiAvailable ? ""
        : state.aiAvailability === "owner_reconnect_required"
          ? "Reconnect your AI provider in Settings → Agents & providers to resume AI requests."
          : "Messages are unavailable while the owner's runtime is offline.";
  return {
    aiAvailable,
    canRequestAi,
    canWrite,
    value,
    status,
    inputLabel: "Message Chat",
    placeholder: !canWrite ? "Read-only access" : "Message Chat…",
    submitLabel: "Send",
  };
}

export function shouldShowSharedAiQueue(state: SharedChatComposerState): boolean {
  const relevantRequests = state.aiRequests.filter((request) => request.state !== "completed");
  return relevantRequests.length > 1
    || relevantRequests.some((request) => ["queued", "waiting_for_approval"].includes(request.state))
    || relevantRequests.some((request) => ["cancelled", "interrupted", "unauthorized", "unavailable"].includes(request.state))
    || state.approvals.some((approval) => approval.state === "pending");
}

export function canControlSharedAiRequest(
  role: CollaborationScope["role"] | undefined,
  actorId: string,
  request: CollaborationAiRequest,
): boolean {
  return role === "owner" || (role === "editor" && request.actor.actorId === actorId);
}
