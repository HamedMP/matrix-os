"use client";
import { SignIn, useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import { createRoutineFullAccessBrowserClient, RoutineFullAccessConsentContent, useRoutineFullAccess, type RoutineFullAccessClient } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { AuthLayout } from "./AuthLayout";

function OwnerCard({ client, chatId, identity }: { client: RoutineFullAccessClient; chatId: string; identity: string }) {
  const controller = useRoutineFullAccess({ client, chatId, identity, enabled: true, browserOrigin: true,
    permissionMode: "full_access", onPermissionModeChange: () => {} });
  return <RoutineFullAccessConsentContent controller={controller}/>;
}
/** GET/login/mount only reads. The owner must review the server scope and explicitly decide. */
export function RoutineFullAccessCompletion() {
  const params = useSearchParams(), { isLoaded, isSignedIn, userId, sessionId, getToken } = useAuth();
  const parsed = CanonicalChatIdSchema.safeParse(params.get("chat"));
  const valid = parsed.success && params.getAll("chat").length === 1 && params.getAll("runtime").length <= 1
    && (!params.has("runtime") || /^[A-Za-z0-9_-]{1,32}$/.test(params.get("runtime")!))
    && [...params.keys()].every(key => key === "chat" || key === "runtime");
  const gatewayUrl = getGatewayUrl();
  const client = useMemo(() => createRoutineFullAccessBrowserClient(gatewayUrl, fetch, getToken), [gatewayUrl, getToken]);
  const returnPath = typeof window === "undefined" ? undefined : window.location.pathname + window.location.search;
  return <AuthLayout featureContent={<div className="space-y-5"><h1 className="text-4xl font-semibold">Routine CLI in your private Chat.</h1>
    <p>This scope applies only to new verified Full Access browser turns, for up to 30 minutes. Device-authenticated turns keep per-operation confirmation.</p>
    <p>Schedule activation, background model consent and integration permissions remain separate.</p></div>}
    formContent={!valid ? <p role="alert">This routine CLI access link is invalid.</p> : !isLoaded ? <p role="status">Checking your Matrix account…</p> : !isSignedIn
      ? <SignIn routing="hash" forceRedirectUrl={returnPath} fallbackRedirectUrl={returnPath}/>
      : <OwnerCard client={client} chatId={parsed.data} identity={JSON.stringify([gatewayUrl, userId, sessionId])}/>}/>;
}
