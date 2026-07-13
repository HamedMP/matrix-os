import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Keyboard,
  Text,
  useWindowDimensions,
  View,
  type KeyboardEvent,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useGateway } from "@/app/_layout";
import { TerminalControlBar } from "@/components/TerminalControlBar";
import { TerminalSurface, type TerminalSurfaceHandle } from "@/components/TerminalSurface";
import { WindowHeader, WindowHeaderAction } from "@/components/WindowHeader";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";
import {
  appendScrollback,
  clearScrollback,
  getScrollback,
  resetScrollback,
} from "@/lib/terminal-scrollback";
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
export default function TerminalScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { client } = useGateway();
  const [state, dispatch] = useReducer(terminalReducer, initialTerminalState);
  const [lastTerminalSessionId, setLastTerminalSessionId] = useState<string | null>(null);
  const [terminalHandoffSessionId, setTerminalHandoffSessionId] = useState<string | null>(null);
  const [terminalResumeLoaded, setTerminalResumeLoaded] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [chromeExpanded, setChromeExpanded] = useState(false);
  const terminalClient = useMemo(() => (client ? new MobileTerminalClient(client) : null), [client]);
  const connectionRef = useRef<MobileTerminalConnection | null>(null);
  const connectAttemptRef = useRef(0);
  const connectingRef = useRef(false);
  const surfaceRef = useRef<TerminalSurfaceHandle | null>(null);
  // The session whose live output is currently streaming, so output frames land
  // in the right scrollback cache bucket (state.activeSessionId lags in closures).
  const attachedSessionIdRef = useRef<string | null>(null);
  const keyboardLift = useRef(new Animated.Value(0)).current;

  // Initial grid; the embedded emulator reports its fitted size via onResize.
  const gridRef = useRef({ cols: 80, rows: 24 });

  const loadSessions = useCallback(async () => {
    if (!terminalClient) return;
    const sessions = await terminalClient.listSessions();
    dispatch({ type: "sessions.loaded", sessions });
    setSessionsLoaded(true);
  }, [terminalClient]);

  useEffect(() => {
    setSessionsLoaded(false);
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    loadMobileShellState()
      .then((saved) => {
        setLastTerminalSessionId(saved.lastActiveTerminalSessionId);
        setTerminalHandoffSessionId(saved.terminalHandoffSessionId ?? null);
      })
      .catch((err: unknown) => {
        console.warn("[mobile] failed to load terminal resume state", err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setTerminalResumeLoaded(true);
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
      // The gateway replay is authoritative and just repainted the cleared
      // surface, so any cached preview is now superseded — reset the cache to it.
      attachedSessionIdRef.current = frame.sessionId;
      resetScrollback(frame.sessionId, frame.replay ?? "");
      dispatch({
        type: "terminal.attached",
        sessionId: frame.sessionId,
        cwd: frame.cwd,
        replay: frame.replay,
      });
      setLastTerminalSessionId(frame.sessionId);
      setTerminalHandoffSessionId(null);
      loadMobileShellState()
        .then((saved) => saveMobileShellState({
          ...saved,
          mode: "terminal",
          lastActiveTerminalSessionId: frame.sessionId,
          terminalHandoffSessionId: null,
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
      if (attachedSessionIdRef.current) appendScrollback(attachedSessionIdRef.current, frame.data);
      dispatch({ type: "terminal.output", data: frame.data });
      return;
    }
    if (frame.type === "exit") {
      if (attachedSessionIdRef.current) clearScrollback(attachedSessionIdRef.current);
      attachedSessionIdRef.current = null;
      dispatch({ type: "terminal.ended", exitCode: frame.exitCode });
      setLastTerminalSessionId(null);
      loadSessions();
      return;
    }
    if (frame.type === "error") {
      dispatch({ type: "terminal.error", message: frame.message ?? "Terminal unavailable" });
    }
  }, [loadSessions]);

  const clearTerminalHandoff = useCallback(() => {
    setTerminalHandoffSessionId(null);
    loadMobileShellState()
      .then((saved) => saveMobileShellState({
        ...saved,
        terminalHandoffSessionId: null,
        updatedAt: new Date().toISOString(),
      }))
      .catch((err: unknown) => {
        console.warn("[mobile] failed to clear terminal handoff state", err instanceof Error ? err.message : String(err));
      });
  }, []);

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
      // Paint the cached scrollback immediately so a reattach shows the previous
      // buffer during the token+WS round-trip instead of a blank surface. The
      // `attached` frame then clears and repaints from the authoritative replay.
      surfaceRef.current?.clear();
      const cachedScrollback = getScrollback(targetName);
      if (cachedScrollback) surfaceRef.current?.write(cachedScrollback);
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

  const animateKeyboardLift = useCallback((event: KeyboardEvent | null, lift: number) => {
    Animated.timing(keyboardLift, {
      toValue: lift,
      duration: event?.duration ?? 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [keyboardLift]);

  useEffect(() => {
    const liftForEvent = (event: KeyboardEvent) => {
      const keyboardTop = event.endCoordinates.screenY;
      const keyboardHeight = Math.max(0, windowHeight - keyboardTop);
      return Math.max(0, keyboardHeight - insets.bottom);
    };
    const show = Keyboard.addListener(
      process.env.EXPO_OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow",
      (event) => animateKeyboardLift(event, liftForEvent(event)),
    );
    const hide = Keyboard.addListener(
      process.env.EXPO_OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      (event) => animateKeyboardLift(event, 0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, [animateKeyboardLift, insets.bottom, windowHeight]);


  const destroySession = useCallback(async () => {
    const sessionId = state.activeSessionId;
    if (sessionId) {
      const deleted = await terminalClient?.deleteSession(sessionId);
      if (!deleted) {
        dispatch({ type: "terminal.error", message: "Terminal unavailable" });
        loadSessions();
        return;
      }
      clearScrollback(sessionId);
    }
    attachedSessionIdRef.current = null;
    connectAttemptRef.current += 1;
    connectingRef.current = false;
    connectionRef.current?.destroy();
    connectionRef.current = null;
    setLastTerminalSessionId(null);
    setTerminalHandoffSessionId(null);
    loadMobileShellState()
      .then((saved) => saveMobileShellState({
        ...saved,
        mode: "terminal",
        lastActiveTerminalSessionId: null,
        terminalHandoffSessionId: null,
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
  const handoffRunningSession = terminalHandoffSessionId
    ? runningSessions.find((session) => session.sessionId === terminalHandoffSessionId) ?? null
    : null;
  const lastRunningSession = lastTerminalSessionId
    ? runningSessions.find((session) => session.sessionId === lastTerminalSessionId) ?? null
    : null;
  // Explicit handoffs come from a tapped terminal row and must not attach a
  // different session if the selected one disappeared before this tab opened.
  const autoAttachSession = terminalHandoffSessionId
    ? handoffRunningSession
    : lastRunningSession ?? runningSessions[0] ?? null;
  const cwd = formatTerminalCwd(state.cwd);

  // Last-session-first: when the terminal opens idle and there is a known last
  // running session, attach to it automatically (once). Picking a session from
  // the Sessions screen updates the persisted last session, so it lands here.
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (autoConnectedRef.current) return;
    if (!terminalResumeLoaded || !sessionsLoaded) return;
    if (state.status !== "idle") return;
    if (terminalHandoffSessionId && !handoffRunningSession) {
      autoConnectedRef.current = true;
      dispatch({ type: "terminal.error", message: "Terminal unavailable" });
      clearTerminalHandoff();
      return;
    }
    if (!autoAttachSession) return;
    autoConnectedRef.current = true;
    connectSession(autoAttachSession.sessionId);
  }, [
    autoAttachSession,
    clearTerminalHandoff,
    connectSession,
    handoffRunningSession,
    sessionsLoaded,
    state.status,
    terminalHandoffSessionId,
    terminalResumeLoaded,
  ]);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <WindowHeader
        tone="terminal"
        paddingTop={insets.top + (chromeExpanded ? 8 : 3)}
        title={chromeExpanded ? "Terminal" : cwd}
        subtitle={chromeExpanded ? cwd : undefined}
        titleAffordance
        onTitlePress={() => setChromeExpanded((value) => !value)}
        onBack={() => router.navigate("/(tabs)/apps")}
        maximized={maximized || !chromeExpanded}
        onToggleMaximized={() => setMaximized((prev) => !prev)}
        actions={
          <>
            <WindowHeaderAction tone="terminal" icon="albums-outline" label="Sessions" onPress={() => router.push("/sessions")} />
            {state.activeSessionId ? (
              <WindowHeaderAction tone="terminal" icon="stop-circle-outline" label="End session" onPress={confirmEnd} tint={theme.terminal.brightRed} />
            ) : null}
            {state.status === "connecting" ? (
              <ActivityIndicator color={theme.colors.accentInk} style={styles.headerSpinner} />
            ) : (
              <WindowHeaderAction tone="terminal" icon="add" label="New session" onPress={() => connectSession()} />
            )}
          </>
        }
      />

      <Animated.View style={[styles.terminalStack, { transform: [{ translateY: Animated.multiply(keyboardLift, -1) }] }]}>
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
            onScroll={(lines) => surfaceRef.current?.scrollLines(lines)}
            onScrollToBottom={() => surfaceRef.current?.scrollToBottom()}
            onDismissKeyboard={() => {
              surfaceRef.current?.blur();
              Keyboard.dismiss();
            }}
            onFontScale={(delta) => dispatch({ type: "font.scale", delta })}
            onClear={() => dispatch({ type: "reset.output" })}
          />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.terminal.bg,
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
  terminalStack: {
    flex: 1,
    backgroundColor: theme.terminal.bg,
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
    backgroundColor: theme.terminal.surface,
  },
}));
