import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { TerminalControlBar } from "@/components/TerminalControlBar";
import { TerminalSurface, type TerminalSurfaceHandle } from "@/components/TerminalSurface";
import { Spacer } from "@/components/ui";
import { useGateway } from "@/app/_layout";
import {
  MobileTerminalClient,
  type MobileTerminalConnection,
  type TerminalServerFrame,
} from "@/lib/terminal-client";
import { isSafeShellSessionName } from "@/lib/terminal-state";
import { colors } from "@/lib/theme";

type LiveStatus = "connecting" | "attached" | "detached" | "ended" | "error";
const TERMINAL_HANDSHAKE_TIMEOUT_MS = 15_000;

export default function TerminalSessionScreen() {
  const params = useLocalSearchParams<{ session?: string | string[] }>();
  const rawSession = Array.isArray(params.session) ? params.session[0] : params.session;
  const session = rawSession && isSafeShellSessionName(rawSession) ? rawSession : null;
  const { client } = useGateway();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [leaseRevoked, setLeaseRevoked] = useState(false);
  const [fontScale, setFontScale] = useState(1);
  const surfaceRef = useRef<TerminalSurfaceHandle | null>(null);
  const connectionRef = useRef<MobileTerminalConnection | null>(null);
  const connectionAttemptRef = useRef(0);
  const handshakeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gridRef = useRef({ cols: 80, rows: 24 });

  const terminalClient = useMemo(
    () => client ? new MobileTerminalClient(client) : null,
    [client],
  );

  const clearHandshakeTimeout = useCallback(() => {
    if (handshakeTimeoutRef.current === null) return;
    clearTimeout(handshakeTimeoutRef.current);
    handshakeTimeoutRef.current = null;
  }, []);

  const handleFrame = useCallback((frame: TerminalServerFrame) => {
    if (frame.type === "attached") {
      clearHandshakeTimeout();
      setLeaseRevoked(false);
      setStatus("attached");
      setError(null);
      surfaceRef.current?.clear();
      if (frame.canonicalSize) {
        surfaceRef.current?.resize(frame.canonicalSize.cols, frame.canonicalSize.rows);
      }
      if (frame.replay) surfaceRef.current?.write(frame.replay);
      surfaceRef.current?.focus();
      return;
    }
    if (frame.type === "canonical-size") {
      surfaceRef.current?.resize(frame.cols, frame.rows);
      return;
    }
    if (frame.type === "presentation-reset") {
      surfaceRef.current?.reset();
      return;
    }
    if (frame.type === "output") {
      surfaceRef.current?.write(frame.data);
      return;
    }
    if (frame.type === "lease-revoked") {
      clearHandshakeTimeout();
      setLeaseRevoked(true);
      setStatus("detached");
      connectionRef.current?.close();
      connectionRef.current = null;
      return;
    }
    if (frame.type === "exit") {
      clearHandshakeTimeout();
      setStatus("ended");
      setError(null);
      connectionRef.current = null;
      return;
    }
    if (frame.type === "error") {
      clearHandshakeTimeout();
      setStatus("error");
      setError("Terminal unavailable. Try again.");
    }
  }, [clearHandshakeTimeout]);

  const connect = useCallback(async () => {
    if (!session || !terminalClient) return;
    const attempt = connectionAttemptRef.current + 1;
    connectionAttemptRef.current = attempt;
    connectionRef.current?.detach();
    connectionRef.current = null;
    clearHandshakeTimeout();
    setStatus("connecting");
    setError(null);
    handshakeTimeoutRef.current = setTimeout(() => {
      if (connectionAttemptRef.current !== attempt) return;
      connectionAttemptRef.current += 1;
      connectionRef.current?.detach();
      connectionRef.current = null;
      setStatus("error");
      setError("Terminal unavailable. Try again.");
    }, TERMINAL_HANDSHAKE_TIMEOUT_MS);

    try {
      const connection = await terminalClient.connect({
        sessionId: session,
        cols: gridRef.current.cols,
        rows: gridRef.current.rows,
        onMessage: (frame) => {
          if (connectionAttemptRef.current === attempt) handleFrame(frame);
        },
        onStatus: (nextStatus) => {
          if (connectionAttemptRef.current !== attempt) return;
          if (nextStatus === "open") {
            clearHandshakeTimeout();
            setStatus("attached");
          }
          if (nextStatus === "closed") {
            clearHandshakeTimeout();
            setStatus((current) => current === "ended" || current === "error" ? current : "detached");
          }
          if (nextStatus === "error") {
            clearHandshakeTimeout();
            setStatus("error");
            setError("Terminal unavailable. Try again.");
          }
        },
      });
      if (connectionAttemptRef.current !== attempt) {
        connection?.detach();
        return;
      }
      if (!connection) {
        clearHandshakeTimeout();
        setStatus("error");
        setError("Terminal unavailable. Try again.");
        return;
      }
      connectionRef.current = connection;
      surfaceRef.current?.focus();
    } catch (connectionError: unknown) {
      if (connectionAttemptRef.current !== attempt) return;
      clearHandshakeTimeout();
      console.warn(
        "[mobile] terminal session connection failed",
        connectionError instanceof Error ? connectionError.name : typeof connectionError,
      );
      setStatus("error");
      setError("Terminal unavailable. Try again.");
    }
  }, [clearHandshakeTimeout, handleFrame, session, terminalClient]);

  useEffect(() => {
    if (!session) {
      setStatus("error");
      setError("Terminal unavailable. Try again.");
      return;
    }
    if (!terminalClient) return;
    void connect();
    return () => {
      connectionAttemptRef.current += 1;
      clearHandshakeTimeout();
      connectionRef.current?.detach();
      connectionRef.current = null;
    };
  }, [clearHandshakeTimeout, connect, session, terminalClient]);

  const sendData = useCallback((data: string) => {
    if (!data || leaseRevoked) return;
    if (!connectionRef.current?.sendInput(data)) {
      setStatus("error");
      setError("Terminal unavailable. Try again.");
    }
  }, [leaseRevoked]);

  const handleResize = useCallback((cols: number, rows: number) => {
    gridRef.current = { cols, rows };
    connectionRef.current?.resize(cols, rows);
  }, []);

  const adjustFontScale = useCallback((delta: number) => {
    setFontScale((current) => Math.max(0.85, Math.min(1.3, Number((current + delta).toFixed(2)))));
  }, []);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <Stack.Screen options={{ title: session ?? "Terminal" }} />

      <View style={styles.surface}>
        <TerminalSurface
          ref={surfaceRef}
          fontScale={fontScale}
          onInput={sendData}
          onResize={handleResize}
        />

        {!client || status === "connecting" ? (
          <View pointerEvents="none" style={styles.overlay}>
            <ActivityIndicator color={colors.terminal.fg} />
            <Spacer size="md" />
            <Text style={styles.overlayText}>Connecting…</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.overlay}>
            <Text style={styles.overlayTitle}>{error}</Text>
            <Spacer size="lg" />
            <Pressable accessibilityRole="button" onPress={() => void connect()} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {leaseRevoked ? (
          <View style={styles.overlay}>
            <Text style={styles.overlayTitle}>Live on another device.</Text>
            <Spacer size="lg" />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setLeaseRevoked(false);
                void connect();
              }}
              style={styles.retryButton}
            >
              <Text style={styles.retryText}>Resume here</Text>
            </Pressable>
          </View>
        ) : null}

        {status === "detached" && !leaseRevoked ? (
          <View style={styles.overlay}>
            <Text style={styles.overlayTitle}>Terminal connection closed.</Text>
            <Spacer size="lg" />
            <Pressable accessibilityRole="button" onPress={() => void connect()} style={styles.retryButton}>
              <Text style={styles.retryText}>Reconnect</Text>
            </Pressable>
          </View>
        ) : null}

        {status === "ended" ? (
          <View style={styles.overlay}>
            <Text style={styles.overlayTitle}>This terminal session has ended.</Text>
          </View>
        ) : null}
      </View>

      <TerminalControlBar
        onSend={sendData}
        onScroll={(lines) => surfaceRef.current?.scrollLines(lines)}
        onScrollToBottom={() => surfaceRef.current?.scrollToBottom()}
        onDismissKeyboard={() => {
          surfaceRef.current?.blur();
          Keyboard.dismiss();
        }}
        onFontScale={adjustFontScale}
        onClear={() => surfaceRef.current?.clear()}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.terminal.bg,
  },
  surface: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    backgroundColor: "rgba(18, 21, 17, 0.88)",
  },
  overlayTitle: {
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
    color: colors.terminal.fg,
  },
  overlayText: {
    fontSize: 13,
    color: colors.terminal.fgDim,
  },
  retryButton: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: colors.terminal.border,
    borderRadius: 10,
    backgroundColor: colors.terminal.surface,
  },
  retryText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.terminal.fg,
  },
});
