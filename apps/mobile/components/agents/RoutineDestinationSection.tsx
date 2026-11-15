import { useMemo, useRef } from "react";
import { Text, View } from "react-native";
import { useAuth } from "@clerk/clerk-expo";
import { StyleSheet } from "react-native-unistyles";
import { ROUTINE_DESTINATION_COPY as copy } from "@matrix-os/contracts/routine-destination";
import { useRoutineDestination, type RoutineDestinationClient } from "@matrix-os/ui/routine-destination";
import { requestRoutineDestination, RoutineDestinationRequestError } from "@/lib/requests/routine-destination";
import { Button } from "@/components/ui";
import { DetailsSection } from "./DetailsSection";
export function RoutineDestinationSection({ gatewayUrl, chatId, botId, eligible }: { gatewayUrl: string; chatId: string; botId: string; eligible: boolean }) {
  const { getToken, userId, sessionId, isLoaded, isSignedIn } = useAuth();
  const current = useRef<object | null>(null);
  const scoped = useMemo(() => {
    const identity = {};
    if (!isLoaded || !isSignedIn || !userId || !gatewayUrl) return { identity, client: null };
    const call = async (kind: "get" | "remember" | "reset", input?: unknown, signal?: AbortSignal) => {
      const token = await getToken();
      if (!token || current.current !== identity || signal?.aborted) throw new RoutineDestinationRequestError(null);
      return requestRoutineDestination(token, gatewayUrl, kind, input, signal);
    };
    const client: RoutineDestinationClient = { get: signal => call("get", undefined, signal), remember: (input, signal) => call("remember", input, signal), reset: (input, signal) => call("reset", input, signal) };
    return { identity, client };
  }, [getToken, gatewayUrl, userId, sessionId, isLoaded, isSignedIn]);
  current.current = scoped.identity;
  const state = useRoutineDestination({ client: scoped.client, botId, chatId, eligible });
  return <DetailsSection label={copy.title} error={state.error} testID="agent-routine-destination">
    <View style={styles.content}>
      <Text accessibilityLiveRegion="polite" style={styles.text}>{state.presentation?.message ?? (state.pending ? copy.loading : copy.unknown)}</Text>
      <Text style={styles.text}>{copy.explanation}</Text>
      {state.presentation?.canRemember !== false && eligible ? <Button variant="outline" label={state.presentation?.remember ?? copy.remember} disabled={state.pending || !state.fresh} onPress={() => { void state.remember(); }}/> : null}
      {state.presentation?.canReset ? <Button variant="outline" label={copy.reset} disabled={state.pending || !state.fresh} onPress={() => { void state.reset(); }}/> : null}
      <Button variant="outline" label={copy.retry} disabled={state.pending} onPress={state.refresh}/>
      {state.pending && state.view ? <Text style={styles.text}>{copy.pending}</Text> : null}
    </View>
  </DetailsSection>;
}
const styles = StyleSheet.create(theme => ({ content: { gap: theme.v2.space[10], paddingBottom: theme.v2.space[10] }, text: { ...theme.v2.text.caption, color: theme.v2.colors.textSubtle } }));
