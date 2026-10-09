import type { AoedeSessionOptions } from "@matrix-os/ui/aoede";
import { buildGatewayUrl } from "../../lib/api";
import { createCanonicalChatClient } from "../../lib/canonical-chat-client";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useConnection } from "../../stores/connection";

// Credentials stay in Electron's trusted network layer. Bind HTTP to the same
// computer as /ws; never reuse a closure after user/runtime/token replacement.
export function createDesktopAoedeTransport() {
  const identity = useConnection.getState();
  const identityKey = desktopProviderIdentityKey(identity);
  if (!identity.api || identity.status !== "signed-in") throw new Error("AoedeSignedOut");
  const api = identity.api.forRuntime(identity.runtimeSlot);
  const canonical = createCanonicalChatClient(api);
  const assertCurrent = () => {
    if (desktopProviderIdentityKey(useConnection.getState()) !== identityKey) throw new Error("AoedeIdentityChanged");
  };
  const fetchFn: typeof fetch = async (input, init) => {
    assertCurrent();
    const url = new URL(String(input));
    if (url.origin !== new URL(identity.platformHost).origin || !url.pathname.startsWith("/api/aoede/")) throw new Error("AoedeInvalidEndpoint");
    const response = await fetch(buildGatewayUrl(identity.platformHost, `${url.pathname}${url.search}`, identity.runtimeSlot), {
      ...init, signal: init?.signal ?? AbortSignal.timeout(10_000),
    });
    assertCurrent();
    return response;
  };
  const submitApproval: AoedeSessionOptions["submitApproval"] = async (card, decision, requestId) => {
    assertCurrent();
    const result = await canonical.submitApproval(card.chatId, card.runId!, card.approval!.approvalId, {
      clientRequestId: requestId, decision: decision === "approve_once" ? "approve" : "decline",
    });
    assertCurrent();
    return result.submission === "accepted";
  };
  return { gatewayUrl: identity.platformHost, identityKey, fetchFn, submitApproval };
}
