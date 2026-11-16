"use client";
import { useAuth } from "@clerk/nextjs";
import { useMemo } from "react";
import { RoutineActionConfirmation, createRoutineActionBrowserClient } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
export function CanonicalRoutineActionMessage({ challengeId }: { challengeId: string }) {
  const { getToken, userId, sessionId } = useAuth(), gateway = getGatewayUrl();
  const client = useMemo(() => createRoutineActionBrowserClient(gateway, getToken), [gateway, getToken]);
  return <RoutineActionConfirmation client={client} challengeId={challengeId} identity={JSON.stringify([gateway, userId, sessionId])}/>;
}
