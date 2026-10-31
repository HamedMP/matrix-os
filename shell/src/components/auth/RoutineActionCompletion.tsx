"use client";
import { SignIn, useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { RoutineActionConfirmation, createRoutineActionBrowserClient } from "@matrix-os/ui";
import { RoutineActionIdSchema, ROUTINE_ACTION_NOTICE } from "@matrix-os/contracts";
import { AuthLayout } from "./AuthLayout";
import { getGatewayUrl } from "@/lib/gateway";
/** Login/GET/mount performs reads only. Only an explicit card button submits the exact stored challenge. */
export function RoutineActionCompletion() {
  const params = useSearchParams(), { isLoaded, isSignedIn, getToken, userId, sessionId } = useAuth();
  const parsed = RoutineActionIdSchema.safeParse(params.get("challenge"));
  const valid = parsed.success && params.getAll("challenge").length === 1 && params.getAll("runtime").length <= 1
    && (!params.has("runtime") || /^[A-Za-z0-9_-]{1,32}$/.test(params.get("runtime")!)) && [...params.keys()].every(key => key === "challenge" || key === "runtime");
  const gateway = getGatewayUrl(), identity = JSON.stringify([gateway, userId, sessionId]);
  const client = useMemo(() => createRoutineActionBrowserClient(gateway, getToken), [gateway, getToken]);
  const returnPath = typeof window === "undefined" ? undefined : window.location.pathname + window.location.search;
  return <AuthLayout featureContent={<div className="space-y-5"><h1 className="text-4xl font-semibold">Confirm one routine operation.</h1><p>{ROUTINE_ACTION_NOTICE}</p></div>}
    formContent={!valid ? <p role="alert">This confirmation link is invalid.</p> : !isLoaded ? <p role="status">Checking your Matrix account…</p> : !isSignedIn
      ? <SignIn routing="hash" forceRedirectUrl={returnPath} fallbackRedirectUrl={returnPath}/>
      : <RoutineActionConfirmation client={client} challengeId={parsed.data} identity={identity}/>}/>;
}
