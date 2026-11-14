import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAuth } from "@clerk/clerk-expo";
import { fetch as expoFetch } from "expo/fetch";
import { getRandomValues } from "expo-crypto";
import { createRoutineActionBrowserClient, useRoutineAction } from "@matrix-os/ui/routine-action";
import { ROUTINE_ACTION_NOTICE, ROUTINE_ACTION_OUTCOME, routineActionDetails, type RoutineActionView } from "@matrix-os/contracts";
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
  return <View accessibilityLabel="Routine operation confirmation" style={styles.card}>
    <Text style={styles.text}>{view?.title ?? "Routine operation confirmation"}</Text><Text style={styles.text}>{ROUTINE_ACTION_NOTICE}</Text>
    {view ? <Text style={styles.text}>{routineActionDetails(view)}</Text> : null}
    <Text style={styles.text}>{status ? ROUTINE_ACTION_OUTCOME[status] : "Loading confirmation…"}</Text>
    {active ? (["approve", "decline", "cancel"] as const).map(decision => <Pressable accessibilityRole="button" key={decision} disabled={busy} style={styles.button} onPress={() => void state.submit(decision)}>
      <Text style={styles.text}>{decision === "approve" ? "Allow once" : decision === "decline" ? "Decline" : "Cancel request"}</Text></Pressable>) : null}
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
  </View>;
}
export function NativeRoutineActionInbox({ gatewayUrl }: { gatewayUrl: string }) {
  const { client, identity } = useOwnerClient(gatewayUrl), [open, setOpen] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const [views, setViews] = useState<RoutineActionView[]>([]), [error, setError] = useState(false);
  useLayoutEffect(() => { setSelected(null); setViews([]); setFresh(false); setError(false); }, [identity, client]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController(); let reading = false;
    const read = async () => { if (reading) return; reading = true;
      try { const result = await client.list(abort.signal); if (!abort.signal.aborted) { setViews(result); setFresh(true); setError(false); } }
      catch (failure: unknown) { console.warn("[routine-action] Native inbox unavailable", failure instanceof Error ? failure.name : "UnknownError"); if (!abort.signal.aborted) { setFresh(false); setError(true); } }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => { void read(); }, 2000); return () => { abort.abort(); clearInterval(timer); };
  }, [client, identity, open]);
  return <View><Pressable accessibilityRole="button" onPress={() => setOpen(value => !value)}><Text style={styles.text}>Routine confirmations</Text></Pressable>
    {open ? <View>{error ? <Text accessibilityRole="alert" style={styles.text}>Routine confirmations unavailable. Refresh to check again.</Text> : !fresh ? <Text style={styles.text}>Loading confirmations…</Text> : !views.length
      ? <Text style={styles.text}>No pending routine confirmations on this Computer.</Text> : views.map(view => <Pressable accessibilityRole="button" key={view.challengeId} onPress={() => setSelected(view.challengeId)}><Text style={styles.text}>{view.title} · {ROUTINE_ACTION_OUTCOME[view.status]}</Text></Pressable>)}
      {selected ? <NativeRoutineActionConfirmation key={`${identity}:${selected}`} gatewayUrl={gatewayUrl} challengeId={selected}/> : null}</View> : null}
  </View>;
}
const styles = StyleSheet.create(theme => ({ card: { padding: 12, gap: 8, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12 },
  text: { color: theme.colors.foreground }, button: { padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 } }));
