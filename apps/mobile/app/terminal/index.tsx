import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
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
  const outputRef = useRef<ScrollView | null>(null);
  const inputRef = useRef<TextInput | null>(null);

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

  useEffect(() => {
    return () => {
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
      dispatch({ type: "terminal.output", data: frame.data });
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

    connectionRef.current?.detach();
    connectionRef.current = null;
    dispatch({ type: "connection.changed", status: "connecting" });

    const nextConnection = await terminalClient.connect({
      sessionId,
      cwd: "projects",
      cols,
      rows,
      onMessage: handleFrame,
      onStatus: (status) => {
        if (status === "open") dispatch({ type: "connection.changed", status: "attached" });
        if (status === "closed") dispatch({ type: "connection.changed", status: "detached" });
        if (status === "error") dispatch({ type: "terminal.error", message: "Terminal unavailable" });
      },
    });
    connectionRef.current = nextConnection;
    inputRef.current?.focus();
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
    connectionRef.current?.destroy();
    connectionRef.current = null;
    if (sessionId) await terminalClient?.deleteSession(sessionId);
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
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={20} color={colors.dark.foreground} />
        </Pressable>
        <View style={styles.headerTitleGroup}>
          <Text style={styles.title}>Terminal</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{cwd}</Text>
        </View>
        {state.status === "connecting" ? (
          <ActivityIndicator color={colors.dark.primary} />
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="New session" onPress={() => connectSession()} style={styles.iconButton}>
            <Ionicons name="add" size={21} color={colors.dark.foreground} />
          </Pressable>
        )}
      </View>

      {runningSessions.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.sessionRow}
          keyboardShouldPersistTaps="handled"
        >
          {runningSessions.map((session) => (
            <Pressable
              key={session.sessionId}
              accessibilityRole="button"
              accessibilityLabel={`Resume ${formatTerminalCwd(session.cwd)}`}
              onPress={() => connectSession(session.sessionId)}
              style={[
                styles.sessionChip,
                session.sessionId === state.activeSessionId && styles.sessionChipActive,
              ]}
            >
              <Text style={styles.sessionChipText} numberOfLines={1}>
                {formatTerminalCwd(session.cwd)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

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

      <View style={[styles.commandArea, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <View style={styles.promptRow}>
          <Text style={styles.promptPath} numberOfLines={1}>{cwd}</Text>
          <Text style={styles.promptSymbol}>$</Text>
          <TextInput
            ref={inputRef}
            value={state.input}
            onChangeText={(input) => dispatch({ type: "terminal.input", input })}
            onSubmitEditing={submitInput}
            editable={connected}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            placeholder={connected ? "command" : "start session"}
            placeholderTextColor="rgba(234, 236, 234, 0.35)"
            style={[styles.commandInput, { fontSize: 14 * state.fontScale }]}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Run command" disabled={!connected} onPress={submitInput} style={styles.runButton}>
            <Ionicons name="return-down-forward" size={18} color={connected ? colors.dark.primary : "rgba(234, 236, 234, 0.32)"} />
          </Pressable>
        </View>
        <View style={styles.actionRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Detach" disabled={!connected} onPress={() => connectionRef.current?.detach()} style={styles.actionButton}>
            <Text style={styles.actionButtonText}>Detach</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Destroy session" disabled={!state.activeSessionId} onPress={destroySession} style={styles.actionButton}>
            <Text style={styles.actionButtonText}>End</Text>
          </Pressable>
        </View>
        <TerminalControlBar
          onSend={sendData}
          onFontScale={(delta) => dispatch({ type: "font.scale", delta })}
          onClear={() => dispatch({ type: "reset.output" })}
        />
      </View>
    </KeyboardAvoidingView>
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
    borderBottomColor: "rgba(140, 199, 190, 0.14)",
  },
  iconButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: "rgba(234, 236, 234, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(140, 199, 190, 0.14)",
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
    borderColor: "rgba(140, 199, 190, 0.14)",
    backgroundColor: "rgba(234, 236, 234, 0.07)",
  },
  sessionChipActive: {
    backgroundColor: "rgba(140, 199, 190, 0.18)",
    borderColor: "rgba(140, 199, 190, 0.38)",
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
    borderColor: "rgba(140, 199, 190, 0.38)",
    backgroundColor: "rgba(140, 199, 190, 0.12)",
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
    borderTopColor: "rgba(140, 199, 190, 0.14)",
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
    borderColor: "rgba(140, 199, 190, 0.14)",
    backgroundColor: "rgba(234, 236, 234, 0.07)",
  },
  actionButtonText: {
    fontFamily: fonts.sansSemiBold,
    color: colors.dark.foreground,
    fontSize: 13,
  },
});
