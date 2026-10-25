"use client";
import { useAuth } from "@clerk/nextjs";
import { useLayoutEffect, useMemo, useRef } from "react";
import { ChatUsagePanel } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { currentAiCreditRuntimeSlot } from "@/lib/ai-credit-checkout";
import { isSelfHostedRuntime } from "@/lib/self-host-mode";
import { createWebChatUsageClient } from "@/lib/chat-usage-transport";

function Unavailable() {
  return <div className="matrix-agents-providers" style={{ marginTop: 24 }}><section className="matrix-ap-panel" aria-label="Chat usage">
    <h2 style={{ fontSize: 16 }}>Chat usage</h2><p>Chat usage requires a signed-in Matrix account and a connected computer.</p>
  </section></div>;
}
export function WebChatUsageSettings() {
  // Self-hosted documents have no ClerkProvider. Their authority does not satisfy this owner-only API.
  if (isSelfHostedRuntime()) return <Unavailable />;
  return <ClerkChatUsageSettings />;
}
function ClerkChatUsageSettings() {
  const { isLoaded, userId, sessionId } = useAuth();
  return isLoaded && userId && sessionId ? <AuthenticatedChatUsageSettings authIdentity={`${userId}:${sessionId}`} /> : <Unavailable />;
}
function AuthenticatedChatUsageSettings({ authIdentity }: { authIdentity: string }) {
  const gateway = getGatewayUrl(); const runtimeSlot = currentAiCreditRuntimeSlot();
  const identityKey = `${authIdentity}:${gateway}:${runtimeSlot}`;
  const current = useRef(identityKey); current.current = identityKey;
  // Establish the new identity before the keyed panel starts its passive reads.
  useLayoutEffect(() => { current.current = identityKey; return () => { current.current = ""; }; }, [identityKey]);
  const client = useMemo(() => createWebChatUsageClient({
    isIdentityCurrent: () => current.current === identityKey && getGatewayUrl() === gateway && currentAiCreditRuntimeSlot() === runtimeSlot,
  }), [identityKey, gateway, runtimeSlot]);
  return <ChatUsagePanel client={client} identityKey={identityKey} />;
}
