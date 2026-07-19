import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ConnectionState, GatewayClient } from "@/lib/gateway-client";

type TurnComposerError =
  | "Conversation is busy. Refresh and try again."
  | "Message could not be sent. Refresh and try again.";

type AgentThreadTurnComposerProps = {
  client: GatewayClient;
  connectionState: ConnectionState;
  onAccepted: () => Promise<void>;
  threadId: string;
};

export function AgentThreadTurnComposer({
  client,
  connectionState,
  onAccepted,
  threadId,
}: AgentThreadTurnComposerProps) {
  const { theme } = useUnistyles();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<TurnComposerError | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  const pendingRef = useRef(false);
  const previousConnectionStateRef = useRef(connectionState);
  const requestIdRef = useRef<`req_${string}` | null>(null);
  const requestSequenceRef = useRef(0);
  const [capability, setCapability] = useState<{
    client: GatewayClient | null;
    enabled: boolean;
  }>({ client: null, enabled: false });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadCapability = useCallback(async (cancelled: () => boolean = () => false) => {
    if (typeof client.getCodingAgentRuntimeSummary !== "function") {
      if (!cancelled()) setCapability({ client, enabled: false });
      return;
    }
    try {
      const result = await client.getCodingAgentRuntimeSummary();
      if (cancelled()) return;
      setCapability({
        client,
        enabled: result.ok && result.summary.capabilities.some((candidate) =>
          candidate.id === "codingAgentsSameThreadTurns" && candidate.enabled),
      });
    } catch {
      console.warn("[mobile] coding-agent turn capability unavailable");
      if (!cancelled()) setCapability({ client, enabled: false });
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadCapability(() => cancelled);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadCapability]);

  useEffect(() => {
    const previous = previousConnectionStateRef.current;
    previousConnectionStateRef.current = connectionState;
    if (previous !== "connected" && connectionState === "connected") {
      let cancelled = false;
      const timer = setTimeout(() => {
        void loadCapability(() => cancelled);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    return undefined;
  }, [connectionState, loadCapability]);

  const enabled = capability.client === client && capability.enabled;

  const changeDraft = useCallback((value: string) => {
    if (pendingRef.current) return;
    setDraft(value);
    setError(null);
    setRefreshError(false);
    requestIdRef.current = null;
  }, []);

  const nextTurnRequestId = useCallback((): `req_${string}` => {
    requestSequenceRef.current = (requestSequenceRef.current + 1) % 1_000_000;
    return `req_mobile_turn_${Date.now().toString(36)}_${requestSequenceRef.current.toString(36)}`;
  }, []);

  const submit = useCallback(async () => {
    const message = draft.trim();
    if (!enabled || connectionState !== "connected" || !message || pendingRef.current) return;
    const clientRequestId = requestIdRef.current ?? nextTurnRequestId();
    requestIdRef.current = clientRequestId;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setRefreshError(false);
    let result: Awaited<ReturnType<GatewayClient["createCodingAgentTurn"]>>;
    try {
      result = await client.createCodingAgentTurn({
        threadId,
        request: { message, clientRequestId },
      });
    } catch {
      result = {
        ok: false,
        error: "Message could not be sent. Refresh and try again.",
        reason: "unavailable",
      };
    }
    pendingRef.current = false;
    if (!mountedRef.current) return;
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    requestIdRef.current = null;
    setDraft("");
    try {
      await onAccepted();
    } catch {
      console.warn("[mobile] accepted coding-agent turn snapshot refresh failed");
      if (mountedRef.current) setRefreshError(true);
    }
  }, [client, connectionState, draft, enabled, nextTurnRequestId, onAccepted, threadId]);

  if (!enabled) return null;

  const connected = connectionState === "connected";
  const disabled = pending || !connected || !draft.trim();
  const buttonLabel = pending
    ? "Sending message to current conversation"
    : error
      ? "Retry message to current conversation"
      : "Send message to current conversation";

  return (
    <View style={styles.container}>
      <View style={styles.headingRow}>
        <Ionicons name="chatbubble-ellipses-outline" size={17} color={theme.colors.moss} />
        <View style={styles.headingCopy}>
          <Text style={styles.title}>Continue this conversation</Text>
          <Text style={styles.detail}>Your message stays on this thread.</Text>
        </View>
      </View>
      <TextInput
        accessibilityLabel="Message current conversation"
        editable={!pending}
        maxLength={24_000}
        multiline
        numberOfLines={4}
        onChangeText={changeDraft}
        placeholder="Ask the agent to continue..."
        placeholderTextColor={theme.colors.mutedForeground}
        style={styles.input}
        textAlignVertical="top"
        value={draft}
      />
      {!connected ? <Text style={styles.recovery}>Reconnect to send a message.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {refreshError ? (
        <Text style={styles.error}>Message sent. Refresh the conversation to see updates.</Text>
      ) : null}
      <Pressable
        accessibilityLabel={buttonLabel}
        accessibilityRole="button"
        disabled={disabled}
        onPress={() => void submit()}
        style={[styles.sendButton, disabled ? styles.disabled : null]}
      >
        <Ionicons name={pending ? "hourglass-outline" : "arrow-up-outline"} size={16} color={theme.colors.background} />
        <Text style={styles.sendText}>{pending ? "Sending" : error ? "Retry" : "Send"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginTop: theme.spacing.lg,
    borderRadius: 16,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.sm,
  },
  headingCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  detail: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  input: {
    minHeight: 96,
    maxHeight: 180,
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  recovery: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  error: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.moss,
  },
  sendButton: {
    minHeight: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.forest,
    paddingHorizontal: theme.spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
  },
  sendText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 14,
    color: theme.colors.background,
  },
  disabled: {
    opacity: 0.5,
  },
}));
