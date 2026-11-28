"use client";
import { useAuth } from "@clerk/nextjs";
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
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
const subscribeRuntime = () => () => undefined;
const serverHosted = () => false;
const clientHosted = () => !isSelfHostedRuntime();
function createIdentityAuthority() {
  let active = false;
  return { isCurrent: () => active, activate: () => { active = true; }, revoke: () => { active = false; } };
}

export function WebChatUsageSettings() {
  // Self-hosted documents have no ClerkProvider. Their authority does not satisfy this owner-only API.
  const hosted = useSyncExternalStore(subscribeRuntime, clientHosted, serverHosted);
  if (!hosted) return <Unavailable />;
  return <ClerkChatUsageSettings />;
}
function ClerkChatUsageSettings() {
  const { isLoaded, userId, sessionId } = useAuth();
  return isLoaded && userId && sessionId ? <AuthenticatedChatUsageSettings authIdentity={`${userId}:${sessionId}`} /> : <Unavailable />;
}
function AuthenticatedChatUsageSettings({ authIdentity }: { authIdentity: string }) {
  const gateway = getGatewayUrl(); const runtimeSlot = currentAiCreditRuntimeSlot();
  const identityKey = `${authIdentity}:${gateway}:${runtimeSlot}`;
  const authority = useMemo(() => createIdentityAuthority(), [identityKey]);
  // Establish the new identity before the keyed panel starts its passive reads.
  useLayoutEffect(() => { authority.activate(); return () => { authority.revoke(); }; }, [authority]);
  const client = useMemo(() => createWebChatUsageClient({
    isIdentityCurrent: () => authority.isCurrent() && getGatewayUrl() === gateway && currentAiCreditRuntimeSlot() === runtimeSlot,
  }), [authority, gateway, runtimeSlot]);
  return <ChatUsagePanel client={client} identityKey={identityKey} />;
}
