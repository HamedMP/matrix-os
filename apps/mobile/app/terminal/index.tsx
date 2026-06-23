import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useGateway } from "@/app/_layout";
import { TerminalControlBar } from "@/components/TerminalControlBar";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";
import {
  MobileTerminalClient,
  type MobileTerminalConnection,
  type TerminalServerFrame,
} from "@/lib/terminal-client";
import {
  formatTerminalCwd,
  initialTerminalState,
  type MobileTerminalSession,
  terminalReducer,
} from "@/lib/terminal-state";
import { colors, fonts } from "@/lib/theme";

export default function TerminalScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { client } = useGateway();
  const [state, dispatch] = useReducer(terminalReducer, initialTerminalState);
  const [lastTerminalSessionId, setLastTerminalSessionId] = useState<string | null>(null);
  const terminalClient = useMemo(() => (client ? new MobileTerminalClient(client) : null), [client]);
  const connectionRef = useRef<MobileTerminalConnection | null>(null);
  const connectAttemptRef = useRef(0);
  const connectingRef = useRef(false);
  const outputRef = useRef<ScrollView | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const cursorRef = useRef<{
    activeSessionId: string | null;
    lastSeq: number | null;
    nextSeq: number | null;
  }>({
    activeSessionId: null,
    lastSeq: null,
    nextSeq: null,
  });

  const cols = Math.max(40, Math.floor(width / (8 * state.fontScale)));
  const rows = Math.max(18, Math.floor(height / (18 * state.fontScale)));

  const loadSessions = useCallback(async () => {
    if (!terminalClient) return;
    const sessions = await terminalClient.listSessions();
    dispatch({ type: "sessions.loaded", sessions });
  }, [terminalClient]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    loadMobileShellState()
      .then((saved) => setLastTerminalSessionId(saved.lastActiveTerminalSessionId))
      .catch((err: unknown) => {
        console.warn("[mobile] failed to load terminal resume state", err instanceof Error ? err.message : String(err));
      });
  }, []);

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount-only teardown intentionally reads the LIVE refs (current connect attempt + active connection) at cleanup time; copying them at mount would capture null/0 and never tear down the real connection
  useEffect(() => {
    return () => {
      connectAttemptRef.current += 1;
      connectingRef.current = false;
      connectionRef.current?.detach();
      connectionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (state.status === "attached") {
      connectionRef.current?.resize(cols, rows);
    }
  }, [cols, rows, state.status]);

  useEffect(() => {
    cursorRef.current = {
      activeSessionId: state.activeSessionId,
      lastSeq: state.lastSeq,
      nextSeq: state.nextSeq,
    };
  }, [state.activeSessionId, state.lastSeq, state.nextSeq]);

  useEffect(() => {
    outputRef.current?.scrollToEnd({ animated: true });
  }, [state.output]);

  const handleFrame = useCallback((frame: TerminalServerFrame) => {
    if (frame.type === "attached") {
      dispatch({
        type: "terminal.attached",
        sessionId: frame.sessionId,
        cwd: frame.cwd,
        replay: frame.replay,
      });
      setLastTerminalSessionId(frame.sessionId);
      loadMobileShellState()
        .then((saved) => saveMobileShellState({
          ...saved,
          mode: "terminal",
          lastActiveTerminalSessionId: frame.sessionId,
          updatedAt: new Date().toISOString(),
        }))
        .catch((err: unknown) => {
          console.warn("[mobile] failed to save terminal resume state", err instanceof Error ? err.message : String(err));
        });
      loadSessions();
      return;
    }
    if (frame.type === "output") {
      dispatch({ type: "terminal.output", data: frame.data, seq: frame.seq });
      return;
    }
    if (frame.type === "replay-end") {
      dispatch({ type: "terminal.replayFinished", toSeq: frame.toSeq });
      return;
    }
    if (frame.type === "exit") {
      dispatch({ type: "terminal.ended", exitCode: frame.exitCode });
      setLastTerminalSessionId(null);
      loadSessions();
      return;
    }
    if (frame.type === "error") {
      dispatch({ type: "terminal.error", message: frame.message ?? "Terminal unavailable" });
    }
  }, [loadSessions]);

  const connectSession = useCallback(async (sessionId?: string) => {
    if (!terminalClient) {
      dispatch({ type: "terminal.error", message: "Terminal unavailable" });
      return;
    }
    if (connectingRef.current) return;

    const attemptId = connectAttemptRef.current + 1;
    connectAttemptRef.current = attemptId;
    connectingRef.current = true;
    connectionRef.current?.detach();
    connectionRef.current = null;
    dispatch({ type: "connection.changed", status: "connecting" });

    let nextConnection: MobileTerminalConnection | null = null;
    try {
      const cursor = cursorRef.current;
      const replayFromSeq = sessionId && sessionId === cursor.activeSessionId
        ? cursor.nextSeq ?? nextSeqFromLastSeq(cursor.lastSeq)
        : undefined;
      nextConnection = await terminalClient.connect({
        sessionId,
        cwd: sessionId ? undefined : "projects",
        fromSeq: replayFromSeq,
        cols,
        rows,
        onMessage: (frame) => {
          if (connectAttemptRef.current === attemptId) handleFrame(frame);
        },
        onStatus: (status) => {
          if (connectAttemptRef.current !== attemptId) return;
          if (status === "open") dispatch({ type: "connection.changed", status: "attached" });
          if (status === "closed") dispatch({ type: "connection.changed", status: "detached" });
          if (status === "error") dispatch({ type: "terminal.error", message: "Terminal unavailable" });
        },
      });
      if (connectAttemptRef.current !== attemptId) {
        nextConnection?.detach();
        return;
      }
      if (!nextConnection) {
        dispatch({ type: "terminal.error", message: "Terminal unavailable" });
        return;
      }
      connectionRef.current = nextConnection;
      inputRef.current?.focus();
    } catch (err: unknown) {
      if (connectAttemptRef.current === attemptId) {
        console.warn("[mobile] terminal connection failed", err instanceof Error ? err.message : String(err));
        dispatch({ type: "terminal.error", message: "Terminal unavailable" });
        dispatch({ type: "connection.changed", status: "detached" });
      }
    } finally {
      if (connectAttemptRef.current === attemptId) {
        connectingRef.current = false;
      }
    }
  }, [cols, handleFrame, rows, terminalClient]);

  const sendData = useCallback((data: string) => {
    if (!data) return;
    const sent = connectionRef.current?.sendInput(data) ?? false;
    if (!sent) dispatch({ type: "terminal.error", message: "Terminal unavailable" });
  }, []);

  const submitInput = useCallback(() => {
    if (!state.input) return;
    sendData(`${state.input}\r`);
    dispatch({ type: "terminal.clearInput" });
  }, [sendData, state.input]);

  const destroySession = useCallback(async () => {
    const sessionId = state.activeSessionId;
    if (sessionId) {
      const deleted = await terminalClient?.deleteSession(sessionId);
      if (!deleted) {
        dispatch({ type: "terminal.error", message: "Terminal unavailable" });
        loadSessions();
        return;
      }
    }
    connectAttemptRef.current += 1;
    connectingRef.current = false;
    connectionRef.current?.destroy();
    connectionRef.current = null;
    setLastTerminalSessionId(null);
    loadMobileShellState()
      .then((saved) => saveMobileShellState({
        ...saved,
        mode: "terminal",
        lastActiveTerminalSessionId: null,
        updatedAt: new Date().toISOString(),
      }))
      .catch((err: unknown) => {
        console.warn("[mobile] failed to clear terminal resume state", err instanceof Error ? err.message : String(err));
      });
    dispatch({ type: "reset.output" });
    dispatch({ type: "connection.changed", status: "idle" });
    loadSessions();
  }, [loadSessions, state.activeSessionId, terminalClient]);

  const runningSessions = state.sessions.filter((session) => session.state === "running");
  const lastRunningSession = lastTerminalSessionId
    ? runningSessions.find((session) => session.sessionId === lastTerminalSessionId) ?? null
    : null;
  const missingLastSession = Boolean(lastTerminalSessionId && state.sessions.length > 0 && !lastRunningSession);
  const connected = state.status === "attached";
  const cwd = formatTerminalCwd(state.cwd);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
      keyboardVerticalOffset={0}
    >
      <TerminalHeader
        cwd={cwd}
        paddingTop={insets.top + 8}
        connecting={state.status === "connecting"}
        onBack={() => router.back()}
        onNewSession={() => connectSession()}
      />

      <SessionChipRow
        sessions={runningSessions}
        activeSessionId={state.activeSessionId}
        onSelect={connectSession}
      />

      {lastRunningSession ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Continue terminal ${formatTerminalCwd(lastRunningSession.cwd)}`}
          onPress={() => connectSession(lastRunningSession.sessionId)}
          style={styles.continueCard}
        >
          <View style={styles.continueIcon}>
            <Ionicons name="terminal" size={20} color={colors.dark.primary} />
          </View>
          <View style={styles.continueTextGroup}>
            <Text style={styles.continueEyebrow}>Continue terminal</Text>
            <Text style={styles.continueTitle} numberOfLines={1}>{formatTerminalCwd(lastRunningSession.cwd)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.dark.primary} />
        </Pressable>
      ) : null}

      {missingLastSession ? (
        <View style={styles.resumeNotice}>
          <Text style={styles.resumeNoticeText}>Last terminal ended. Start a new session to continue.</Text>
        </View>
      ) : null}

      <Pressable onPress={() => inputRef.current?.focus()} style={styles.terminalSurface}>
        <ScrollView
          ref={outputRef}
          style={styles.output}
          contentContainerStyle={styles.outputContent}
          keyboardShouldPersistTaps="handled"
        >
          {state.output ? (
            <Text selectable style={[styles.outputText, { fontSize: 12 * state.fontScale }]}>
              {state.output}
            </Text>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No terminal session</Text>
              <Text style={styles.emptySubtitle}>Start a session to run commands on your Matrix VPS.</Text>
            </View>
          )}
        </ScrollView>
      </Pressable>

      {state.error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{state.error}</Text>
        </View>
      )}

      <CommandArea
        cwd={cwd}
        paddingBottom={Math.max(insets.bottom, 8)}
        connected={connected}
        canDestroy={Boolean(state.activeSessionId)}
        input={state.input}
        fontScale={state.fontScale}
        inputRef={inputRef}
        onChangeInput={(input) => dispatch({ type: "terminal.input", input })}
        onSubmit={submitInput}
        onDetach={() => connectionRef.current?.detach()}
        onDestroy={destroySession}
        onSend={sendData}
        onFontScale={(delta) => dispatch({ type: "font.scale", delta })}
        onClear={() => dispatch({ type: "reset.output" })}
      />
    </KeyboardAvoidingView>
  );
}

function nextSeqFromLastSeq(lastSeq: number | null): number | undefined {
  if (lastSeq === null || !Number.isSafeInteger(lastSeq) || lastSeq < 0) return undefined;
  if (lastSeq >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return lastSeq + 1;
}

interface TerminalHeaderProps {
  cwd: string;
  paddingTop: number;
  connecting: boolean;
  onBack: () => void;
  onNewSession: () => void;
}

function TerminalHeader({ cwd, paddingTop, connecting, onBack, onNewSession }: TerminalHeaderProps) {
  return (
    <View style={[styles.header, { paddingTop }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={styles.iconButton}>
        <Ionicons name="chevron-back" size={20} color={colors.dark.foreground} />
      </Pressable>
      <View style={styles.headerTitleGroup}>
        <Text style={styles.title}>Terminal</Text>
        <Text style={styles.subtitle} numberOfLines={1}>{cwd}</Text>
      </View>
      {connecting ? (
        <ActivityIndicator color={colors.dark.primary} />
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="New session" onPress={onNewSession} style={styles.iconButton}>
          <Ionicons name="add" size={21} color={colors.dark.foreground} />
        </Pressable>
      )}
    </View>
  );
}

interface SessionChipProps {
  session: MobileTerminalSession;
  active: boolean;
  onSelect: (sessionId: string) => void;
}

const SessionChip = React.memo(function SessionChip({ session, active, onSelect }: SessionChipProps) {
  const handlePress = useCallback(() => onSelect(session.sessionId), [onSelect, session.sessionId]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Resume ${formatTerminalCwd(session.cwd)}`}
      onPress={handlePress}
      style={active ? styles.sessionChipActiveCombined : styles.sessionChip}
    >
      <Text style={styles.sessionChipText} numberOfLines={1}>
        {formatTerminalCwd(session.cwd)}
      </Text>
    </Pressable>
  );
});

interface SessionChipRowProps {
  sessions: MobileTerminalSession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

function SessionChipRow({ sessions, activeSessionId, onSelect }: SessionChipRowProps) {
  const keyExtractor = useCallback((session: MobileTerminalSession) => session.sessionId, []);
  const renderItem = useCallback(
    ({ item: session }: { item: MobileTerminalSession }) => (
      <SessionChip
        session={session}
        active={session.sessionId === activeSessionId}
        onSelect={onSelect}
      />
    ),
    [activeSessionId, onSelect],
  );
  if (sessions.length === 0) return null;
  return (
    <FlatList
      horizontal
      data={sessions}
      keyExtractor={keyExtractor}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.sessionRow}
      keyboardShouldPersistTaps="handled"
      renderItem={renderItem}
    />
  );
}

interface CommandAreaProps {
  cwd: string;
  paddingBottom: number;
  connected: boolean;
  canDestroy: boolean;
  input: string;
  fontScale: number;
  inputRef: React.RefObject<TextInput | null>;
  onChangeInput: (input: string) => void;
  onSubmit: () => void;
  onDetach: () => void;
  onDestroy: () => void;
  onSend: (data: string) => void;
  onFontScale: (delta: number) => void;
  onClear: () => void;
}

function CommandArea({
  cwd,
  paddingBottom,
  connected,
  canDestroy,
  input,
  fontScale,
  inputRef,
  onChangeInput,
  onSubmit,
  onDetach,
  onDestroy,
  onSend,
  onFontScale,
  onClear,
}: CommandAreaProps) {
  return (
    <View style={[styles.commandArea, { paddingBottom }]}>
      <View style={styles.promptRow}>
        <Text style={styles.promptPath} numberOfLines={1}>{cwd}</Text>
        <Text style={styles.promptSymbol}>$</Text>
        <TextInput
          ref={inputRef}
          value={input}
          onChangeText={onChangeInput}
          onSubmitEditing={onSubmit}
          editable={connected}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          placeholder={connected ? "command" : "start session"}
          placeholderTextColor="rgba(234, 236, 234, 0.35)"
          style={[styles.commandInput, { fontSize: 14 * fontScale }]}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Run command" disabled={!connected} onPress={onSubmit} style={styles.runButton}>
          <Ionicons name="return-down-forward" size={18} color={connected ? colors.dark.primary : "rgba(234, 236, 234, 0.32)"} />
        </Pressable>
      </View>
      <View style={styles.actionRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="Detach" disabled={!connected} onPress={onDetach} style={styles.actionButton}>
          <Text style={styles.actionButtonText}>Detach</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Destroy session" disabled={!canDestroy} onPress={onDestroy} style={styles.actionButton}>
          <Text style={styles.actionButtonText}>End</Text>
        </Pressable>
      </View>
      <TerminalControlBar
        onSend={onSend}
        onFontScale={onFontScale}
        onClear={onClear}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0f120f",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(154, 164, 140, 0.14)",
  },
  iconButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: "rgba(234, 236, 234, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(154, 164, 140, 0.14)",
  },
  headerTitleGroup: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: fonts.sansBold,
    color: colors.dark.foreground,
    fontSize: 18,
  },
  subtitle: {
    marginTop: 2,
    fontFamily: fonts.mono,
    color: colors.dark.primary,
    fontSize: 12,
  },
  sessionRow: {
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  sessionChip: {
    maxWidth: 180,
    paddingHorizontal: 12,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "rgba(154, 164, 140, 0.14)",
    backgroundColor: "rgba(234, 236, 234, 0.07)",
  },
  sessionChipActiveCombined: {
    maxWidth: 180,
    paddingHorizontal: 12,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 11,
    borderWidth: 1,
    backgroundColor: "rgba(154, 164, 140, 0.18)",
    borderColor: "rgba(154, 164, 140, 0.38)",
  },
  sessionChipText: {
    fontFamily: fonts.mono,
    color: colors.dark.foreground,
    fontSize: 12,
  },
  continueCard: {
    marginHorizontal: 14,
    marginBottom: 8,
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(154, 164, 140, 0.38)",
    backgroundColor: "rgba(154, 164, 140, 0.12)",
  },
  continueIcon: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: "rgba(234, 236, 234, 0.08)",
  },
  continueTextGroup: {
    flex: 1,
    minWidth: 0,
  },
  continueEyebrow: {
    fontFamily: fonts.sansSemiBold,
    color: colors.dark.primary,
    fontSize: 12,
  },
  continueTitle: {
    marginTop: 2,
    fontFamily: fonts.monoBold,
    color: colors.dark.foreground,
    fontSize: 14,
  },
  resumeNotice: {
    marginHorizontal: 14,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.35)",
    backgroundColor: "rgba(245, 158, 11, 0.12)",
  },
  resumeNoticeText: {
    fontFamily: fonts.sansMedium,
    color: "#fde68a",
    fontSize: 12,
  },
  terminalSurface: {
    flex: 1,
  },
  output: {
    flex: 1,
  },
  outputContent: {
    flexGrow: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 18,
  },
  outputText: {
    fontFamily: fonts.mono,
    color: colors.dark.foreground,
    lineHeight: 18,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  emptyTitle: {
    fontFamily: fonts.sansBold,
    color: colors.dark.foreground,
    fontSize: 17,
  },
  emptySubtitle: {
    marginTop: 6,
    textAlign: "center",
    fontFamily: fonts.sans,
    color: colors.dark.mutedForeground,
    fontSize: 13,
    lineHeight: 18,
  },
  errorBar: {
    marginHorizontal: 14,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.38)",
    backgroundColor: "rgba(239, 68, 68, 0.12)",
  },
  errorText: {
    fontFamily: fonts.sansMedium,
    color: "#fecaca",
    fontSize: 12,
  },
  commandArea: {
    borderTopWidth: 1,
    borderTopColor: "rgba(154, 164, 140, 0.14)",
    backgroundColor: "#0f120f",
  },
  promptRow: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
  },
  promptPath: {
    maxWidth: 118,
    fontFamily: fonts.mono,
    color: colors.dark.primary,
    fontSize: 12,
  },
  promptSymbol: {
    fontFamily: fonts.monoBold,
    color: colors.dark.foreground,
    fontSize: 14,
  },
  commandInput: {
    flex: 1,
    minHeight: 42,
    paddingVertical: 8,
    fontFamily: fonts.mono,
    color: colors.dark.foreground,
  },
  runButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  actionButton: {
    flex: 1,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(154, 164, 140, 0.14)",
    backgroundColor: "rgba(234, 236, 234, 0.07)",
  },
  actionButtonText: {
    fontFamily: fonts.sansSemiBold,
    color: colors.dark.foreground,
    fontSize: 13,
  },
});
