"use client";
import { useAuth } from "@clerk/nextjs";
import { useMemo } from "react";
import { RoutineActionInbox, createRoutineActionBrowserClient } from "@matrix-os/ui";
import { isSelfHostedRuntime } from "@/lib/self-host-mode";
import { getGatewayUrl } from "@/lib/gateway";
export function TerminalRoutineConfirmations() {
  return isSelfHostedRuntime() ? null : <HostedTerminalRoutineConfirmations/>;
}
function HostedTerminalRoutineConfirmations() {
  const { getToken, userId, sessionId } = useAuth(), gateway = getGatewayUrl();
  const client = useMemo(() => createRoutineActionBrowserClient(gateway, getToken), [gateway, getToken]);
  return <RoutineActionInbox client={client} identity={JSON.stringify([gateway, userId, sessionId])}/>;
}
