"use client";
import { useCallback } from "react";
import { useAoedeSession as useSharedAoedeSession } from "@matrix-os/ui/aoede";
import type { AoedeCard, AoedeServerMessage } from "@matrix-os/contracts";
import { useSocket } from "@/hooks/useSocket";
import { getGatewayUrl } from "@/lib/gateway";
import { createCanonicalShellChatClient } from "@/lib/canonical-chat-client";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "@/lib/canonical-provider-setup";
import type { UiResult } from "./shell-actions";

const fetchFn: typeof fetch = (input, init) => fetch(input, {
  ...init, signal: init?.signal ?? AbortSignal.timeout(30_000),
});
export function useAoedeSession(active: boolean, onUi: (frame: Extract<AoedeServerMessage, { type: "aoede:ui" }>) => UiResult) {
  const socket = useSocket();
  const gatewayUrl = getGatewayUrl();
  const submitApproval = useCallback(async (card: AoedeCard, decision: "approve_once" | "deny", requestId: string) => {
    const result = await createCanonicalShellChatClient({ gatewayUrl }).submitApproval(card.chatId, card.runId!,
      card.approval!.approvalId, decision === "approve_once" ? "approve" : "decline", requestId);
    return result.submission === "accepted";
  }, [gatewayUrl]);
  return useSharedAoedeSession(active, onUi, { gatewayUrl, identityKey: gatewayUrl, fetchFn, socket, submitApproval,
    readinessEvent: PROVIDER_SETTINGS_CHANGED_EVENT });
}
