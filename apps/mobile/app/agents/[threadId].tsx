import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { AgentThreadSnapshot } from "@matrix-os/contracts";
import { useGateway } from "@/app/_layout";

type ThreadRouteState =
  | { status: "loading"; snapshot: null; error: null }
  | { status: "ready"; snapshot: AgentThreadSnapshot; error: "Thread state unavailable" | null; refreshing: boolean }
  | { status: "error"; snapshot: null; error: "Thread state unavailable" };

export default function AgentThreadRoute() {
  const { theme } = useUnistyles();
  const params = useLocalSearchParams<{ threadId?: string }>();
  const threadId = typeof params.threadId === "string" ? params.threadId : "thread";
  const { client } = useGateway();
  const requestGeneration = useRef(0);
  const [state, setState] = useState<ThreadRouteState>({
    status: "loading",
    snapshot: null,
    error: null,
  });

  const loadSnapshot = useCallback(async (cancelled: () => boolean = () => false) => {
    if (!client || !threadId) {
      setState((current) => current.status === "ready"
        ? { ...current, error: "Thread state unavailable", refreshing: false }
        : { status: "error", snapshot: null, error: "Thread state unavailable" });
      return;
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setState((current) => current.status === "ready"
      ? { ...current, error: null, refreshing: true }
      : { status: "loading", snapshot: null, error: null });
    const result = await client.getCodingAgentThreadSnapshot({ threadId });
    if (cancelled() || generation !== requestGeneration.current) return;
    if (result.ok) {
      setState({ status: "ready", snapshot: result.snapshot, error: null, refreshing: false });
      return;
    }
    setState((current) => current.status === "ready"
      ? { ...current, error: "Thread state unavailable", refreshing: false }
      : { status: "error", snapshot: null, error: "Thread state unavailable" });
  }, [client, threadId]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadSnapshot(() => cancelled);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadSnapshot]);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.forest} />
        <Text style={styles.title}>Loading thread...</Text>
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.centered}>
        <Ionicons name="warning-outline" size={28} color={theme.colors.moss} />
        <Text style={styles.title}>{state.error}</Text>
        <Text style={styles.body}>Refresh the workspace or open the thread again.</Text>
      </View>
    );
  }

  const { thread, events } = state.snapshot;
  const terminalSessionId = thread.terminalSessionId ?? "No terminal bound";

  return (
    <ScrollView
      style={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
    >
      <View style={styles.panel}>
        <View style={styles.headerRow}>
          <View style={styles.threadIcon}>
            <Ionicons name="git-branch-outline" size={18} color={theme.colors.moss} />
          </View>
          <View style={styles.headerText}>
            <Text selectable style={styles.title}>{thread.title}</Text>
            <Text selectable style={styles.body}>{thread.providerId}</Text>
          </View>
          <Text style={styles.status}>{thread.status.replace(/_/g, " ")}</Text>
        </View>
        <View style={styles.metaGrid}>
          <MetaItem label="Thread" value={thread.id} />
          <MetaItem label="Terminal" value={terminalSessionId} />
          <MetaItem label="Updated" value={thread.updatedAt} />
          <MetaItem label="Activity" value={`${events.items.length} ${events.items.length === 1 ? "event" : "events"}`} />
        </View>
        {events.hasMore ? (
          <Text style={styles.body}>Older activity is available from the runtime.</Text>
        ) : null}
        {state.error ? (
          <Text style={styles.inlineError}>{state.error}</Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh thread"
          onPress={() => void loadSnapshot()}
          style={styles.refreshButton}
        >
          <Ionicons name="refresh-outline" size={16} color={theme.colors.background} />
          <Text style={styles.refreshText}>{state.refreshing ? "Refreshing" : "Refresh"}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text selectable style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingTop: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: rt.insets.bottom + 32,
  },
  panel: {
    borderRadius: 16,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  threadIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 17,
    color: theme.colors.foreground,
  },
  body: {
    fontFamily: theme.fonts.mono,
    fontSize: 13,
    color: theme.colors.mutedForeground,
  },
  status: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.forest,
  },
  metaGrid: {
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  metaItem: {
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.md,
    gap: 2,
  },
  metaLabel: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  metaValue: {
    fontFamily: theme.fonts.mono,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  refreshButton: {
    marginTop: theme.spacing.sm,
    minHeight: 40,
    borderRadius: 20,
    paddingHorizontal: theme.spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.forest,
  },
  refreshText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.background,
  },
  inlineError: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.moss,
  },
}));
