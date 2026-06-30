import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useGateway } from "@/app/_layout";
import { TerminalControlBar } from "@/components/TerminalControlBar";
import { TerminalSurface, type TerminalSurfaceHandle } from "@/components/TerminalSurface";
import { WindowHeader, WindowHeaderAction } from "@/components/WindowHeader";
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
export default function TerminalScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { client } = useGateway();
  const [state, dispatch] = useReducer(terminalReducer, initialTerminalState);
  const [lastTerminalSessionId, setLastTerminalSessionId] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const terminalClient = useMemo(() => (client ? new MobileTerminalClient(client) : null), [client]);
  const connectionRef = useRef<MobileTerminalConnection | null>(null);
  const connectAttemptRef = useRef(0);
  const connectingRef = useRef(false);
  const surfaceRef = useRef<TerminalSurfaceHandle | null>(null);

  // Initial grid; the embedded emulator reports its fitted size via onResize.
  const gridRef = useRef({ cols: 80, rows: 24 });

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

  // The embedded xterm fits itself to the WebView and reports the grid size;
  // forward it to the live shell so server-side wrapping matches the display.
  const handleResize = useCallback((nextCols: number, nextRows: number) => {
    gridRef.current = { cols: nextCols, rows: nextRows };
    connectionRef.current?.resize(nextCols, nextRows);
  }, []);

  const handleFrame = useCallback((frame: TerminalServerFrame) => {
    if (frame.type === "attached") {
      surfaceRef.current?.clear();
      if (frame.replay) surfaceRef.current?.write(frame.replay);
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
      surfaceRef.current?.write(frame.data);
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
    if (connectingRef.current) return;

    const attemptId = connectAttemptRef.current + 1;
    connectAttemptRef.current = attemptId;
    connectingRef.current = true;
    connectionRef.current?.detach();
    connectionRef.current = null;
    dispatch({ type: "connection.changed", status: "connecting" });

    let nextConnection: MobileTerminalConnection | null = null;
    try {
      // No session name => create a fresh shell session, then attach to it by name.
      let targetName = sessionId;
      if (!targetName) {
        targetName = (await terminalClient.createSession()) ?? undefined;
        if (!targetName) {
          if (connectAttemptRef.current === attemptId) {
            dispatch({ type: "terminal.error", message: "Terminal unavailable" });
            dispatch({ type: "connection.changed", status: "detached" });
          }
          return;
        }
      }
      if (connectAttemptRef.current !== attemptId) return;
      nextConnection = await terminalClient.connect({
        sessionId: targetName,
        cols: gridRef.current.cols,
        rows: gridRef.current.rows,
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
      surfaceRef.current?.focus();
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
  }, [handleFrame, terminalClient]);

  const sendData = useCallback((data: string) => {
    if (!data) return;
    const sent = connectionRef.current?.sendInput(data) ?? false;
    if (!sent) dispatch({ type: "terminal.error", message: "Terminal unavailable" });
  }, []);


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

  const confirmEnd = useCallback(() => {
    Alert.alert("End session?", "This stops the session and its processes. This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "End session", style: "destructive", onPress: () => void destroySession() },
    ]);
  }, [destroySession]);

  const runningSessions = state.sessions.filter((session) => session.state === "running");
  const lastRunningSession = lastTerminalSessionId
    ? runningSessions.find((session) => session.sessionId === lastTerminalSessionId) ?? null
    : null;
  // Last-session-first: prefer the remembered session, else fall back to any running one.
  const autoAttachSession = lastRunningSession ?? runningSessions[0] ?? null;
  const cwd = formatTerminalCwd(state.cwd);

  // Last-session-first: when the terminal opens idle and there is a known last
  // running session, attach to it automatically (once). Picking a session from
  // the Sessions screen updates the persisted last session, so it lands here.
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (autoConnectedRef.current) return;
    if (state.status !== "idle") return;
    if (!autoAttachSession) return;
    autoConnectedRef.current = true;
    connectSession(autoAttachSession.sessionId);
  }, [state.status, autoAttachSession, connectSession]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
      keyboardVerticalOffset={0}
    >
      <WindowHeader
        paddingTop={insets.top + 8}
        title="Terminal"
        subtitle={cwd}
        titleAffordance
        onTitlePress={() => router.push("/sessions")}
        onBack={() => router.navigate("/(tabs)/apps")}
        maximized={maximized}
        onToggleMaximized={() => setMaximized((prev) => !prev)}
        actions={
          <>
            {state.activeSessionId ? (
              <WindowHeaderAction icon="stop-circle-outline" label="End session" onPress={confirmEnd} tint={theme.colors.destructive} />
            ) : null}
            {state.status === "connecting" ? (
              <ActivityIndicator color={theme.colors.accentInk} style={styles.headerSpinner} />
            ) : (
              <WindowHeaderAction icon="add" label="New session" onPress={() => connectSession()} />
            )}
          </>
        }
      />

      {maximized ? null : (
        <SessionChipRow
          sessions={runningSessions}
          activeSessionId={state.activeSessionId}
          onSelect={connectSession}
        />
      )}

      <View style={styles.terminalSurface}>
        <TerminalSurface
          ref={surfaceRef}
          fontScale={state.fontScale}
          onInput={sendData}
          onResize={handleResize}
        />
        {state.status === "idle" ? (
          <View style={styles.emptyOverlay} pointerEvents="none">
            <Text style={styles.emptyTitle}>No terminal session</Text>
            <Text style={styles.emptySubtitle}>Start a session to run commands on your Matrix VPS.</Text>
          </View>
        ) : null}
      </View>

      {state.error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{state.error}</Text>
        </View>
      )}

      <View style={[styles.controlFooter, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <TerminalControlBar
          onSend={sendData}
          onFontScale={(delta) => dispatch({ type: "font.scale", delta })}
          onClear={() => dispatch({ type: "reset.output" })}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

interface SessionChipProps {
  session: MobileTerminalSession;
  active: boolean;
  onSelect: (sessionId: string) => void;
}

const SessionChip = React.memo(function SessionChip({ session, active, onSelect }: SessionChipProps) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => onSelect(session.sessionId), [onSelect, session.sessionId]);
  const status = session.visualStatus;
  const hollow = status === "idle" || status === "finished";
  const dotColor = status === "waiting"
    ? theme.colors.statusWaiting
    : hollow
      ? theme.colors.statusIdle
      : theme.colors.statusRunning;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Resume ${formatTerminalCwd(session.cwd)}`}
      onPress={handlePress}
      style={active ? styles.sessionChipActiveCombined : styles.sessionChip}
    >
      <View
        style={[
          styles.chipDot,
          { backgroundColor: hollow ? "transparent" : dotColor, borderColor: dotColor, borderWidth: hollow ? 1.5 : 0 },
        ]}
      />
      <Text style={styles.sessionChipText} numberOfLines={1}>
        {session.sessionId}
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
      style={styles.sessionStrip}
      contentContainerStyle={styles.sessionRow}
      keyboardShouldPersistTaps="handled"
      renderItem={renderItem}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.paper,
  },
  headerSpinner: {
    width: 38,
    height: 38,
  },
  sessionStrip: {
    // Horizontal lists otherwise stretch to fill the column and shove the
    // terminal into the bottom half — pin the strip to its content height.
    flexGrow: 0,
    maxHeight: 50,
  },
  sessionRow: {
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  sessionChip: {
    maxWidth: 190,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    height: 34,
    justifyContent: "center",
    borderRadius: 11,
    borderWidth: 1,
    borderColor: theme.colors.line,
    backgroundColor: theme.colors.field,
  },
  sessionChipActiveCombined: {
    maxWidth: 190,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    height: 34,
    justifyContent: "center",
    borderRadius: 11,
    borderWidth: 1,
    backgroundColor: theme.colors.panel,
    borderColor: theme.colors.borderStrong,
  },
  chipDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  sessionChipText: {
    fontFamily: theme.fonts.mono,
    color: theme.colors.ink,
    fontSize: 12,
  },
  // Full-bleed dark console — no floating frame; the light WindowHeader above
  // and the control footer below are the only chrome.
  terminalSurface: {
    flex: 1,
    backgroundColor: theme.terminal.bg,
    overflow: "hidden",
  },
  emptyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    backgroundColor: theme.terminal.bg,
  },
  emptyTitle: {
    fontFamily: theme.fonts.sansBold,
    color: theme.terminal.fg,
    fontSize: 17,
  },
  emptySubtitle: {
    marginTop: 6,
    textAlign: "center",
    fontFamily: theme.fonts.sans,
    color: theme.terminal.fgDim,
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
    borderColor: "rgba(239, 68, 68, 0.30)",
    backgroundColor: "rgba(239, 68, 68, 0.07)",
  },
  errorText: {
    fontFamily: theme.fonts.sansMedium,
    color: theme.colors.destructive,
    fontSize: 12,
  },
  controlFooter: {
    backgroundColor: theme.colors.paper,
  },
}));
