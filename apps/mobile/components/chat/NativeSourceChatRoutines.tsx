import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Linking, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAuth } from "@clerk/clerk-expo";
import { fetch as expoFetch } from "expo/fetch";
import type { RoutineChatOriginHistoryItem } from "@matrix-os/contracts";
import {
  createOwnerBrowserJsonRequest, createRoutineOriginClient, routineApprovalPlacement,
  routineOriginBrowserUrl, routineOriginHistoryStatus, useRoutineOrigin,
} from "@matrix-os/ui/routine-origin";
import { Button } from "@/components/ui";
import { RoutineApprovalCard } from "@/components/agents/interactions/RoutineApprovalCard";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";
import type { MessageListProps } from "./MessageList";

export interface NativeSourceChatRoutineScope {
  gatewayUrl: string;
  chatId: string;
  eligible: boolean;
}

export type NativeSourceChatRoutineSlots = Pick<MessageListProps, "renderAfterMessage" | "earlier" | "footer">;
const noMessages: readonly TranscriptMessage[] = [];

export function NativeSourceChatRoutines({ gatewayUrl, chatId, eligible, messages = noMessages, children }: NativeSourceChatRoutineScope & {
  messages?: readonly TranscriptMessage[];
  children?: (slots: NativeSourceChatRoutineSlots) => ReactNode;
}) {
  const { getToken, userId, sessionId } = useAuth();
  const current = useRef<object | null>(null);
  const identityKey = JSON.stringify([userId, sessionId, chatId, eligible]);
  const scope = useMemo(() => {
    const identity = { key: identityKey };
    const gateway = new URL(gatewayUrl);
    const runtime = gateway.searchParams.get("runtime");
    if (runtime) {
      gateway.pathname += `/~runtime/${runtime}`;
      gateway.search = "";
    }
    // eslint-disable-next-line react-hooks/refs -- The transport calls this only after the scope effect.
    const request = createOwnerBrowserJsonRequest(gateway.toString(), async () => {
      const token = await getToken();
      if (current.current !== identity) throw new Error("Chat context changed");
      return token;
    }, expoFetch as typeof fetch);
    return { identity, client: createRoutineOriginClient((path, method, body, options) => {
      if (method !== "GET") throw new Error("Review in browser");
      return request({ path, method, body, signal: options?.signal });
    }) };
  }, [gatewayUrl, getToken, identityKey]);
  useLayoutEffect(() => {
    current.current = scope.identity;
    return () => { current.current = null; };
  }, [scope]);

  const state = useRoutineOrigin({ client: scope.client, chatId, eligible });
  const placement = useMemo(() => routineApprovalPlacement(state.view, [...messages].reverse().map(message => ({
    id: message.id,
    boundary: message.role === "user" || Boolean(message.scheduledMessage || message.routineReceipt),
  }))), [messages, state.view]);
  const [notice, setNotice] = useState<{ identity: object; text: string } | null>(null);
  const message = notice?.identity === scope.identity ? notice.text : "";
  const setMessage = (text: string) => {
    if (current.current === scope.identity) setNotice({ identity: scope.identity, text });
  };
  const open = async (interactionId: string) => {
    if (!eligible || !state.fresh || current.current !== scope.identity ||
        !state.view?.pending.some(({ interaction }) => interaction.interactionId === interactionId)) return;
    try {
      const gateway = new URL(gatewayUrl);
      await Linking.openURL(routineOriginBrowserUrl(gateway.origin, gateway.pathname + gateway.search, chatId, interactionId));
      setMessage("Continue in your browser to review this scheduled task.");
    } catch (error: unknown) {
      console.warn("[routine-origin] Browser unavailable", error instanceof Error ? error.name : "UnknownError");
      setMessage("The browser could not be opened. Try again.");
    }
  };

  const renderApprovals = (items: readonly RoutineChatOriginHistoryItem[]) => items.map(item => {
    const { interaction } = item;
    const historicalStatus = routineOriginHistoryStatus(item);
    const review = () => void open(interaction.interactionId);
    return <View key={interaction.interactionId} style={styles.cards}>
      <RoutineApprovalCard preview={interaction.payload?.kind === "approval" ? interaction.payload.preview : ""}
        botId={interaction.agentId} testID={`origin-${interaction.interactionId}`} sending={null} error={null}
        stale={!state.fresh} closed="Review in your browser to respond." historicalStatus={historicalStatus}
        onAllow={review} onDeny={review} />
      {!historicalStatus ? <Button label="Review in browser" disabled={!state.fresh} onPress={review} /> : null}
    </View>;
  });

  if (!eligible) return children?.({}) ?? null;
  const earlier = placement.earlier.length > 0 ? <View style={styles.panel}>
    <Text style={styles.text}>From an earlier message in this Chat.</Text>
    {renderApprovals(placement.earlier)}
  </View> : null;
  const footer = placement.currentChanges.length > 0 || state.view?.deliveryPending || state.view?.hasMore || state.error || message ? <View style={styles.panel}>
    {renderApprovals(placement.currentChanges)}
    {state.view?.deliveryPending ? <Text style={styles.text}>Scheduled task results are still arriving or unavailable. Check execution history in Schedules.</Text> : null}
    {state.view?.hasMore ? <Text style={styles.text}>More scheduled task items are available in Schedules.</Text> : null}
    {state.error ? <>
      <Text accessibilityRole="alert" style={styles.text}>{state.error}</Text>
      <Button label="Refresh scheduled tasks" onPress={state.refresh} />
    </> : null}
    {message ? <Text style={styles.text}>{message}</Text> : null}
  </View> : null;
  return children ? children({
    earlier, footer,
    renderAfterMessage: row => {
      const items = placement.after.get(row.id);
      return items ? <View style={styles.inline}>{renderApprovals(items)}</View> : null;
    },
  }) : <>{earlier}{footer}</>;
}

const styles = StyleSheet.create(theme => ({
  panel: { gap: 8, padding: 12 },
  cards: { gap: 8 },
  inline: { gap: 8, marginTop: theme.v2.space[14] },
  text: { color: theme.colors.foreground },
}));
