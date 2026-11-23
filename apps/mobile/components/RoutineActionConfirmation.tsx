import { useMemo } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAuth } from "@clerk/clerk-expo";
import { fetch as expoFetch } from "expo/fetch";
import { getRandomValues } from "expo-crypto";
import { createRoutineActionBrowserClient, useRoutineAction } from "@matrix-os/ui/routine-action";
import { ROUTINE_ACTION_NOTICE, ROUTINE_ACTION_OUTCOME, routineActionDetails } from "@matrix-os/contracts";
import { ApprovalRequestCard } from "./chat/ApprovalRequestCard";
/** The existing Native Mobile Clerk getToken path, with shared exact challenge/decision state. */
function useOwnerClient(gatewayUrl: string) {
  const { getToken, userId, sessionId } = useAuth();
  const gateway = new URL(gatewayUrl), runtime = gateway.searchParams.get("runtime");
  if (gateway.search && (!runtime || [...gateway.searchParams.keys()].some(key => key !== "runtime") || !/^[A-Za-z0-9_-]{1,32}$/.test(runtime))) throw new Error("Confirmation unavailable");
  if (runtime) { gateway.pathname += `/~runtime/${runtime}`; gateway.search = ""; }
  const url = gateway.toString();
  return { client: useMemo(() => createRoutineActionBrowserClient(url, getToken, expoFetch as typeof fetch), [url, getToken]),
    identity: JSON.stringify([url, userId, sessionId]) };
}
const requestId = () => `req_${Array.from(getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
export function NativeRoutineActionConfirmation({ challengeId, gatewayUrl }: { challengeId: string; gatewayUrl: string }) {
  const { client, identity } = useOwnerClient(gatewayUrl);
  const state = useRoutineAction({ client, identity, challengeId, createRequestId: requestId });
  const { view, status, busy, active, error } = state;
  return <ApprovalRequestCard accessibilityLabel="Routine operation confirmation"
    title={view?.title ?? "Routine operation confirmation"} summary={ROUTINE_ACTION_NOTICE}
    waiting={active} label={active ? undefined : status ? ROUTINE_ACTION_OUTCOME[status] : "Loading confirmation…"}
    error={error} actions={(["approve", "decline", "cancel"] as const).map(decision => ({
      key: decision, label: decision === "approve" ? "Allow once" : decision === "decline" ? "Not now" : "Cancel request",
      primary: decision === "approve", disabled: busy, onPress: () => void state.submit(decision),
    }))}>
    {view ? <Text style={styles.text}>{routineActionDetails(view)}</Text> : null}
  </ApprovalRequestCard>;
}
const styles = StyleSheet.create(theme => ({ text: { color: theme.colors.foreground } }));
