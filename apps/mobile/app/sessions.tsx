import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useGateway } from "@/app/_layout";
import { MobileTerminalClient } from "@/lib/terminal-client";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";
import type { MobileTerminalSession, ShellVisualStatus } from "@/lib/terminal-state";
import { colors } from "@/lib/theme";

const L = colors.light;

const STATUS_META: Record<ShellVisualStatus, { label: string; color: string; hollow?: boolean }> = {
  waiting: { label: "waiting for input", color: L.statusWaiting },
  running: { label: "running", color: L.statusRunning },
  idle: { label: "idle", color: L.statusIdle, hollow: true },
  finished: { label: "finished", color: L.statusDone },
};

type Group = { key: string; title: string; sessions: MobileTerminalSession[] };

function groupSessions(sessions: MobileTerminalSession[]): Group[] {
  const attention = sessions.filter((s) => s.visualStatus === "waiting");
  const active = sessions.filter((s) => s.visualStatus === "running" || (!s.visualStatus && s.state === "running"));
  const background = sessions.filter(
    (s) => s.visualStatus === "idle" || s.visualStatus === "finished" || (s.state !== "running" && !s.visualStatus),
  );
  return [
    { key: "attention", title: "Needs attention", sessions: attention },
    { key: "active", title: "Active", sessions: active },
    { key: "background", title: "Background", sessions: background },
  ].filter((g) => g.sessions.length > 0);
}

export default function SessionsScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { client } = useGateway();
  const terminalClient = useMemo(() => (client ? new MobileTerminalClient(client) : null), [client]);
  const [sessions, setSessions] = useState<MobileTerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // No gateway yet (still connecting): resolve to the empty/connect state
    // instead of pinning the spinner forever. `load` re-runs once the client
    // arrives because terminalClient is memoized on it.
    if (!terminalClient) {
      setSessions([]);
      setLoading(false);
      return;
    }
    try {
      setSessions(await terminalClient.listSessions());
    } catch (err: unknown) {
      console.warn("[mobile] failed to load sessions", err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [terminalClient]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadMobileShellState()
      .then((state) => setActiveSessionId(state.lastActiveTerminalSessionId))
      .catch((err: unknown) => {
        console.warn("[mobile] failed to load active terminal session", err instanceof Error ? err.message : String(err));
      });
  }, []);

  const openSession = useCallback(async (name: string) => {
    try {
      const saved = await loadMobileShellState();
      await saveMobileShellState({
        ...saved,
        mode: "terminal",
        lastActiveTerminalSessionId: name,
        updatedAt: new Date().toISOString(),
      });
      setActiveSessionId(name);
    } catch (err: unknown) {
      console.warn("[mobile] failed to persist active session", err instanceof Error ? err.message : String(err));
    }
    router.replace("/terminal");
  }, [router]);

  const createSession = useCallback(async () => {
    const name = await terminalClient?.createSession();
    if (!name) {
      Alert.alert("Couldn't create session", "The terminal is unavailable right now. Try again in a moment.");
      return;
    }
    await openSession(name);
  }, [terminalClient, openSession]);

  const endSession = useCallback(
    (name: string) => {
      Alert.alert("End session?", "This stops the session and its processes. This can't be undone.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "End session",
          style: "destructive",
          onPress: async () => {
            await terminalClient?.deleteSession(name);
            load();
          },
        },
      ]);
    },
    [terminalClient, load],
  );

  const groups = groupSessions(sessions);
  const waitingCount = sessions.filter((s) => s.visualStatus === "waiting").length;
  const listContentStyle = useMemo(() => ({ paddingBottom: insets.bottom + 24 }), [insets.bottom]);

  const renderGroup = useCallback(
    ({ item: group }: { item: Group }) => (
      <View>
        <Text style={styles.sectionLabel}>{group.title}</Text>
        {group.sessions.map((session) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            active={session.sessionId === activeSessionId}
            onOpen={() => openSession(session.sessionId)}
            onEnd={() => endSession(session.sessionId)}
          />
        ))}
      </View>
    ),
    [activeSessionId, openSession, endSession],
  );

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => router.back()} style={styles.iconButton}>
          <Ionicons name="chevron-down" size={20} color={theme.colors.ink} />
        </Pressable>
        <View style={styles.headerTitleGroup}>
          <Text style={styles.title}>Sessions</Text>
          <Text style={styles.subtitle}>
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
            {waitingCount > 0 ? ` · ${waitingCount} waiting` : ""}
          </Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="New session" onPress={createSession} style={styles.newButton}>
          <Ionicons name="add" size={22} color="#C7D2B8" />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.accentInk} />
        </View>
      ) : sessions.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="terminal-outline" size={30} color={theme.colors.inkDim} />
          <Text style={styles.emptyTitle}>No sessions yet</Text>
          <Text style={styles.emptySubtitle}>Start one here — it stays open and you can continue it from desktop too.</Text>
          <Pressable accessibilityRole="button" onPress={createSession} style={styles.emptyCta}>
            <Ionicons name="add" size={17} color={theme.colors.accentInk} />
            <Text style={styles.emptyCtaText}>New session</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={groups}
          keyExtractor={(g) => g.key}
          contentContainerStyle={listContentStyle}
          renderItem={renderGroup}
        />
      )}
    </View>
  );
}

function SessionRow({
  session,
  active,
  onOpen,
  onEnd,
}: {
  session: MobileTerminalSession;
  active: boolean;
  onOpen: () => void;
  onEnd: () => void;
}) {
  const { theme } = useUnistyles();
  const status = session.visualStatus ? STATUS_META[session.visualStatus] : STATUS_META.running;
  const onDesktop = (session.attachedClients ?? 0) > 1;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${active ? "Current session" : "Open"} ${session.sessionId}`}
      onPress={onOpen}
      style={[styles.row, active && styles.rowActive]}
    >
      <View style={styles.dotLane}>
        <View style={[styles.dot, { backgroundColor: status.hollow ? "transparent" : status.color, borderColor: status.color, borderWidth: status.hollow ? 1.5 : 0 }]} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>{session.sessionId}</Text>
        <Text style={[styles.statusText, session.visualStatus === "waiting" && styles.statusWaiting]} numberOfLines={1}>
          {active ? "current" : status.label}
        </Text>
        {onDesktop ? (
          <View style={styles.desktopBadge}>
            <Ionicons name="desktop-outline" size={12} color={theme.colors.accentInk} />
            <Text style={styles.desktopText}>Also open on desktop · tap to continue</Text>
          </View>
        ) : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`End ${session.sessionId}`} onPress={onEnd} hitSlop={10} style={styles.endButton}>
        <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.inkDim} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.paper },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.line,
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.line,
  },
  headerTitleGroup: { flex: 1, minWidth: 0 },
  title: { fontFamily: theme.fonts.sansBold, fontSize: 22, letterSpacing: -0.4, color: theme.colors.ink },
  subtitle: { marginTop: 2, fontFamily: theme.fonts.mono, fontSize: 12, color: theme.colors.inkMuted },
  newButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 13,
    backgroundColor: theme.colors.forest,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 32 },
  emptyTitle: { fontFamily: theme.fonts.sansBold, fontSize: 17, color: theme.colors.ink },
  emptySubtitle: { textAlign: "center", fontFamily: theme.fonts.sans, fontSize: 13, lineHeight: 19, color: theme.colors.inkMuted },
  emptyCta: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 16,
    height: 44,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.panel,
  },
  emptyCtaText: { fontFamily: theme.fonts.sansSemiBold, fontSize: 15, color: theme.colors.accentInk },
  sectionLabel: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.inkMuted,
    paddingHorizontal: 20,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 13,
    paddingHorizontal: 16,
    paddingVertical: 13,
    paddingLeft: 20,
    borderTopWidth: 1,
    borderTopColor: theme.colors.lineSoft,
  },
  dotLane: { width: 20, paddingTop: 3, alignItems: "center" },
  dot: { width: 9, height: 9, borderRadius: 999 },
  rowBody: { flex: 1, minWidth: 0, gap: 5 },
  rowTitle: { flexShrink: 1, fontFamily: theme.fonts.sansSemiBold, fontSize: 15, letterSpacing: -0.15, color: theme.colors.ink },
  statusText: { fontFamily: theme.fonts.mono, fontSize: 12, color: theme.colors.inkMuted },
  statusWaiting: { fontFamily: theme.fonts.monoBold, color: theme.colors.glow },
  desktopBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: theme.colors.line,
    backgroundColor: theme.colors.panel,
  },
  rowActive: {
    borderColor: theme.colors.accentInk,
    backgroundColor: theme.colors.secondary,
  },
  desktopText: { fontFamily: theme.fonts.sansMedium, fontSize: 11, color: theme.colors.accentInk },
  endButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
}));
