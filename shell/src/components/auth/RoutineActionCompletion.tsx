"use client";
import { SignIn, useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { RoutineActionConfirmation, createRoutineActionBrowserClient } from "@matrix-os/ui";
import { BotInteractionIdSchema, CanonicalChatIdSchema, RoutineActionIdSchema, ROUTINE_ACTION_NOTICE } from "@matrix-os/contracts";
import { RoutineOriginCompletion } from "./RoutineOriginCompletion";
import { AuthLayout } from "./AuthLayout";
import { getGatewayUrl } from "@/lib/gateway";
/** Login/GET/mount performs reads only. Only an explicit card button submits the exact stored challenge. */
export function RoutineActionCompletion() {
  const params = useSearchParams(), { isLoaded, isSignedIn, getToken, userId, sessionId } = useAuth();
  const parsed = RoutineActionIdSchema.safeParse(params.get("challenge"));
  const valid = parsed.success && params.getAll("challenge").length === 1 && params.getAll("runtime").length <= 1
    && (!params.has("runtime") || /^[A-Za-z0-9_-]{1,32}$/.test(params.get("runtime")!)) && [...params.keys()].every(key => key === "challenge" || key === "runtime");
  const originChat=CanonicalChatIdSchema.safeParse(params.get("originChat")), interaction=BotInteractionIdSchema.safeParse(params.get("interaction"));
  const originValid=originChat.success&&interaction.success&&params.getAll("originChat").length===1&&params.getAll("interaction").length===1&&params.getAll("runtime").length<=1&&(!params.has("runtime")||/^[A-Za-z0-9_-]{1,32}$/.test(params.get("runtime")!))&&[...params.keys()].every(key=>["originChat","interaction","runtime"].includes(key));
  const gateway = getGatewayUrl(), identity = JSON.stringify([gateway, userId, sessionId]);
  const returnPath = typeof window === "undefined" ? undefined : window.location.pathname + window.location.search;
  return <AuthLayout featureContent={<div className="space-y-5"><h1 className="text-4xl font-semibold">{originValid ? "Review your scheduled task." : "Confirm one routine operation."}</h1><p>{originValid ? "Review the task, model and access before approving." : ROUTINE_ACTION_NOTICE}</p></div>}
    formContent={!valid && !originValid ? <p role="alert">This confirmation link is invalid.</p> : !isLoaded ? <p role="status">Checking your Matrix account…</p> : !isSignedIn
      ? <SignIn routing="hash" forceRedirectUrl={returnPath} fallbackRedirectUrl={returnPath}/>
      : originValid ? <RoutineOriginCompletion key={JSON.stringify([identity,originChat.data,interaction.data])} chatId={originChat.data} interactionId={interaction.data} getToken={getToken} identity={identity}/> : parsed.success ? <ExactOperationReview gateway={gateway} getToken={getToken} challengeId={parsed.data} identity={identity}/> : null}/>;
}

function ExactOperationReview({ gateway, getToken, challengeId, identity }: {
  gateway: string; getToken: () => Promise<string | null>; challengeId: string; identity: string;
}) {
  const client = useMemo(() => createRoutineActionBrowserClient(gateway, getToken), [gateway, getToken]);
  return <RoutineActionConfirmation client={client} challengeId={challengeId} identity={identity}/>;
}
