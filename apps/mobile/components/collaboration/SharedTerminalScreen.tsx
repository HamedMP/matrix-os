import {
  CollaborationScopeSchema,
  CollaborationTerminalFrameSchema,
  CollaborationTerminalSchema,
  type CollaborationScope,
  type CollaborationTerminal,
  type CollaborationTerminalAction,
} from "@matrix-os/contracts/collaboration";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  collaborationTerminalUrl,
  controlSharedTerminal,
  fetchCollaborationEventTicket,
  fetchCollaborationScope,
  fetchSharedTerminal,
} from "@/lib/requests/collaboration";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_SOCKET_FRAME_CHARS = 512 * 1024;
const LEASE_RENEW_INTERVAL_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 10_000;

type State = {
  scope: CollaborationScope | null;
  terminal: CollaborationTerminal | null;
  connectionId: string | null;
  output: string;
  loading: boolean;
  pending: boolean;
  unavailable: boolean;
  error: string;
};

type StateAction =
  | { type: "loaded"; scope: CollaborationScope; terminal: CollaborationTerminal }
  | { type: "ready"; terminal: CollaborationTerminal; connectionId: string }
  | { type: "state"; terminal: CollaborationTerminal }
  | { type: "output"; data: string }
  | { type: "pending"; value: boolean }
  | { type: "error"; message: string }
  | { type: "unavailable" };

type TerminalActionInput<T> = T extends CollaborationTerminalAction
  ? Omit<T, "clientRequestId" | "incarnation">
  : never;
type ScopedTerminalAction = TerminalActionInput<CollaborationTerminalAction>;

const initialState: State = {
  scope: null,
  terminal: null,
  connectionId: null,
  output: "",
  loading: true,
  pending: false,
  unavailable: false,
  error: "",
};

export function SharedTerminalScreen({ scopeId, actorId, getToken, onBack }: {
  scopeId: string;
  actorId: string;
  getToken: () => Promise<string>;
  onBack: () => void;
}) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [input, setInput] = useState("");
  const terminalRef = useRef<CollaborationTerminal | null>(null);
  const connectionIdRef = useRef<string | null>(null);

  const loadCanonical = useCallback(async () => {
    const actorToken = await getToken();
    const [scope, terminal] = await Promise.all([
      fetchCollaborationScope(actorToken, scopeId),
      fetchSharedTerminal(actorToken, scopeId),
    ]);
    const parsedScope = CollaborationScopeSchema.parse(scope);
    const parsedTerminal = CollaborationTerminalSchema.parse(terminal);
    if (parsedScope.kind !== "terminal" || parsedTerminal.scopeId !== parsedScope.id) {
      throw new Error("TerminalScopeMismatch");
    }
    terminalRef.current = parsedTerminal;
    dispatch({ type: "loaded", scope: parsedScope, terminal: parsedTerminal });
  }, [getToken, scopeId]);

  useEffect(() => {
    let active = true;
    void loadCanonical().catch((failure: unknown) => {
      console.warn("[mobile-terminal-collaboration] terminal load failed", failure instanceof Error ? failure.name : "UnknownError");
      if (active) dispatch({ type: "error", message: "This shared terminal is unavailable. Your access may have changed." });
    });
    return () => { active = false; };
  }, [loadCanonical]);

  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- cleanup below cancels reconnect/heartbeat timers and closes the current socket; clearHeartbeat is a local cleanup helper.
  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let attempt = 0;
    let sequence = BigInt(0);
    const clearHeartbeat = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };
    const scheduleReconnect = (connect: () => Promise<void>) => {
      const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * (2 ** Math.min(attempt++, 5)));
      retryTimer = setTimeout(() => { void connect(); }, delay);
    };
    const connect = async () => {
      try {
        const actorToken = await getToken();
        const ticket = await fetchCollaborationEventTicket(actorToken, scopeId, randomUuid(), "terminal");
        if (closed) return;
        const NativeWebSocket = WebSocket as unknown as new (
          target: string,
          protocols?: string | string[],
          options?: { headers: Record<string, string> },
        ) => WebSocket;
        const next = new NativeWebSocket(collaborationTerminalUrl(scopeId, ticket.ticket), undefined, {
          headers: { Authorization: `Bearer ${actorToken}` },
        });
        socket = next;
        next.onopen = () => {
          attempt = 0;
          clearHeartbeat();
          heartbeatTimer = setInterval(() => {
            if (!closed && socket === next && next.readyState === WebSocket.OPEN) {
              next.send(JSON.stringify({ version: 1, type: "heartbeat" }));
            }
          }, LEASE_RENEW_INTERVAL_MS);
        };
        next.onmessage = (event) => {
          if (typeof event.data !== "string" || event.data.length > MAX_SOCKET_FRAME_CHARS) {
            next.close(1008, "Invalid frame");
            return;
          }
          try {
            const frame = CollaborationTerminalFrameSchema.parse(JSON.parse(event.data) as unknown);
            if (frame.scopeId !== scopeId) throw new Error("TerminalScopeMismatch");
            if (frame.type === "terminal.ready") {
              sequence = maxSequence(sequence, frame.sequence);
              terminalRef.current = frame.terminal;
              connectionIdRef.current = frame.connectionId;
              dispatch({ type: "ready", terminal: frame.terminal, connectionId: frame.connectionId });
            } else if (frame.type === "terminal.output") {
              const nextSequence = BigInt(frame.sequence);
              if (nextSequence > sequence) {
                sequence = nextSequence;
                dispatch({ type: "output", data: frame.data });
              }
            } else if (frame.type === "terminal.state") {
              sequence = maxSequence(sequence, frame.sequence);
              terminalRef.current = frame.terminal;
              dispatch({ type: "state", terminal: frame.terminal });
            } else if (frame.type === "terminal.refresh_required") {
              sequence = maxSequence(sequence, frame.sequence);
              void loadCanonical().catch((failure: unknown) => {
                console.warn("[mobile-terminal-collaboration] canonical refresh failed", failure instanceof Error ? failure.name : "UnknownError");
                next.close(1011, "Refresh failed");
              });
            } else {
              closed = true;
              clearHeartbeat();
              terminalRef.current = null;
              connectionIdRef.current = null;
              setInput("");
              dispatch({ type: "unavailable" });
              next.close(1008, "Unavailable");
            }
          } catch (failure: unknown) {
            console.warn("[mobile-terminal-collaboration] frame rejected", failure instanceof Error ? failure.name : "UnknownError");
            next.close(1008, "Invalid frame");
          }
        };
        next.onerror = () => next.close();
        next.onclose = () => {
          clearHeartbeat();
          if (socket === next) socket = null;
          if (!closed) scheduleReconnect(connect);
        };
      } catch (failure: unknown) {
        console.warn("[mobile-terminal-collaboration] connection failed", failure instanceof Error ? failure.name : "UnknownError");
        if (!closed) scheduleReconnect(connect);
      }
    };
    void connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearHeartbeat();
      socket?.close(1000, "Closed");
    };
  }, [getToken, loadCanonical, scopeId]);

  const controller = state.terminal?.controller;
  const holdsControl = controller?.actor.actorId === actorId;
  const canControl = Boolean(state.scope?.capabilities.controlTerminal && state.scope.role !== "viewer"
    && state.terminal?.status === "active" && !state.unavailable);
  const canStop = Boolean(state.terminal?.status === "active" && !state.unavailable
    && (state.scope?.capabilities.stopTerminal
      || (state.scope?.role === "editor" && state.terminal.createdBy.actorId === actorId)));

  const sendAction = useCallback(async (action: ScopedTerminalAction) => {
    const terminal = terminalRef.current;
    const connectionId = connectionIdRef.current;
    if (!terminal || (action.type !== "stop" && !connectionId)) return false;
    dispatch({ type: "pending", value: true });
    try {
      const result = await controlSharedTerminal(await getToken(), scopeId, {
        ...action,
        clientRequestId: randomUuid(),
        incarnation: terminal.incarnation,
        ...(action.type === "stop" ? {} : { connectionId: connectionId! }),
      } as CollaborationTerminalAction);
      terminalRef.current = result.terminal;
      dispatch({ type: "state", terminal: result.terminal });
      return true;
    } catch (failure: unknown) {
      console.warn("[mobile-terminal-collaboration] action failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "error", message: "The terminal action could not be completed. Refresh and try again." });
      return false;
    }
  }, [getToken, scopeId]);

  useEffect(() => {
    if (!holdsControl || !controller || !canControl) return;
    const timer = setInterval(() => {
      void sendAction({ type: "renew", connectionId: connectionIdRef.current!, leaseEpoch: controller.leaseEpoch });
    }, LEASE_RENEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [canControl, controller, holdsControl, sendAction]);

  const controlLabel = useMemo(() => {
    if (state.scope?.role === "viewer") return "Watching only";
    if (holdsControl) return "You have control";
    if (controller) return `${controller.actor.displayName} has control`;
    return "No one has control";
  }, [controller, holdsControl, state.scope?.role]);

  const submitText = async (type: "input" | "paste") => {
    if (!holdsControl || !controller || !input) return;
    const accepted = await sendAction({
      type,
      connectionId: connectionIdRef.current!,
      leaseEpoch: controller.leaseEpoch,
      data: input,
    });
    if (accepted) setInput("");
  };

  return <View style={styles.screen}>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to Shared with me" onPress={onBack}>
        <Text style={styles.back}>‹ Shared with me</Text>
      </Pressable>
      <Text style={styles.title}>Shared terminal</Text>
      <Text style={styles.status}>{controlLabel}</Text>
    </View>
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text> : null}
    {state.unavailable ? <Text accessibilityRole="alert" style={styles.error}>
      This shared terminal is no longer available. Return to Shared with me to check your access.
    </Text> : null}
    <ScrollView style={styles.output} contentContainerStyle={styles.outputContent}>
      <Text accessibilityLabel="Shared terminal output" style={styles.outputText}>
        {state.output || (state.loading ? "Connecting to shared terminal…" : "No retained output.")}
      </Text>
    </ScrollView>
    <View style={styles.controls}>
      {canControl && !holdsControl && !controller ? <Action label="Request control" disabled={state.pending || !state.connectionId}
        onPress={() => { void sendAction({ type: "acquire", connectionId: connectionIdRef.current! }); }} /> : null}
      {canControl && !holdsControl && controller && state.scope?.role === "owner" ? <Action
        label={`Take control from ${controller.actor.displayName}`} disabled={state.pending || !state.connectionId}
        onPress={() => { void sendAction({ type: "takeover", connectionId: connectionIdRef.current! }); }} /> : null}
      {canControl && holdsControl && controller ? <Action label="Release control" disabled={state.pending}
        onPress={() => { void sendAction({ type: "release", connectionId: connectionIdRef.current!, leaseEpoch: controller.leaseEpoch }); }} /> : null}
      {canStop ? <Action label="Stop terminal" disabled={state.pending} onPress={() => { void sendAction({ type: "stop" }); }} /> : null}
      <TextInput accessibilityLabel="Terminal input" value={input} onChangeText={setInput}
        editable={Boolean(holdsControl && !state.pending && !state.unavailable)} multiline
        placeholder={holdsControl ? "Type terminal input" : "Take control to send input"} style={styles.input} />
      <View style={styles.actionRow}>
        <Action label="Send input" disabled={!holdsControl || !input || state.pending} onPress={() => { void submitText("input"); }} />
        <Action label="Paste text" disabled={!holdsControl || !input || state.pending} onPress={() => { void submitText("paste"); }} />
      </View>
    </View>
  </View>;
}

function reduce(state: State, action: StateAction): State {
  if (action.type === "loaded") return { ...state, scope: action.scope, terminal: action.terminal, loading: false, error: "" };
  if (action.type === "ready") return { ...state, terminal: action.terminal, connectionId: action.connectionId,
    loading: false, unavailable: false, error: "" };
  if (action.type === "state") return { ...state, terminal: action.terminal, pending: false, error: "" };
  if (action.type === "output") return { ...state, output: appendBounded(state.output, action.data) };
  if (action.type === "pending") return { ...state, pending: action.value, error: "" };
  if (action.type === "error") return { ...state, loading: false, pending: false, error: action.message };
  return { ...state, terminal: null, connectionId: null, output: "", loading: false, pending: false, unavailable: true, error: "" };
}

function appendBounded(current: string, addition: string): string {
  const combined = current + addition;
  const encoded = new TextEncoder().encode(combined);
  if (encoded.byteLength <= MAX_OUTPUT_BYTES) return combined;
  return new TextDecoder().decode(encoded.slice(encoded.byteLength - MAX_OUTPUT_BYTES));
}

function maxSequence(current: bigint, next: string): bigint {
  const parsed = BigInt(next);
  return parsed > current ? parsed : current;
}

function randomUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function Action({ label, disabled = false, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={[styles.action, disabled && styles.disabled]}><Text style={styles.actionText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.v2.appColors.canvas },
  header: { gap: 5, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.v2.colors.borderSubtle },
  back: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.action },
  title: { fontFamily: theme.v2.fonts.display, fontSize: 24, color: theme.v2.appColors.ink },
  status: { fontFamily: theme.v2.fonts.semibold, fontSize: 13, color: theme.v2.appColors.muted },
  error: { paddingHorizontal: 20, paddingVertical: 10, fontFamily: theme.v2.fonts.semibold, fontSize: 13, color: theme.v2.colors.textDefault },
  output: { flex: 1, backgroundColor: "#101218" },
  outputContent: { flexGrow: 1, padding: 16 },
  outputText: { color: "#e4e4e7", fontFamily: theme.v2.fonts.mono, fontSize: 13, lineHeight: 19 },
  controls: { gap: 8, padding: 16, borderTopWidth: 1, borderTopColor: theme.v2.colors.borderSubtle },
  input: { minHeight: 68, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 12, padding: 12,
    color: theme.v2.appColors.ink, fontFamily: theme.v2.fonts.mono, textAlignVertical: "top" },
  actionRow: { flexDirection: "row", gap: 8 },
  action: { flex: 1, alignItems: "center", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11,
    backgroundColor: theme.v2.palette.green[800] },
  actionText: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.textInverse },
  disabled: { opacity: 0.55 },
}));
