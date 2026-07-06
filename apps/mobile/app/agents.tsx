import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { RuntimeSummary } from "@matrix-os/contracts";
import { useGateway } from "@/app/_layout";
import { CODING_AGENTS_MOBILE_WORKSPACE } from "@/lib/feature-flags";

type ScreenState =
  | { status: "loading"; summary: null; error: null }
  | { status: "ready"; summary: RuntimeSummary; error: null }
  | { status: "error"; summary: null; error: "Runtime summary unavailable" };

const INITIAL_STATE: ScreenState = { status: "loading", summary: null, error: null };

export default function AgentsScreen() {
  const { theme } = useUnistyles();
  const { client } = useGateway();
  const [state, setState] = useState<ScreenState>(INITIAL_STATE);
  const [refreshing, setRefreshing] = useState(false);

  const loadSummary = useCallback(async () => {
    if (!CODING_AGENTS_MOBILE_WORKSPACE) {
      setState({ status: "error", summary: null, error: "Runtime summary unavailable" });
      return;
    }
    if (!client) {
      setState({ status: "error", summary: null, error: "Runtime summary unavailable" });
      return;
    }
    const result = await client.getCodingAgentRuntimeSummary();
    if (result.ok) {
      setState({ status: "ready", summary: result.summary, error: null });
      return;
    }
    setState({ status: "error", summary: null, error: "Runtime summary unavailable" });
  }, [client]);

  useEffect(() => {
    setState((current) => (current.summary ? current : INITIAL_STATE));
    void loadSummary();
  }, [loadSummary]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadSummary();
    } finally {
      setRefreshing(false);
    }
  }, [loadSummary]);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.forest} />
        <Text style={styles.centerTitle}>Loading workspace...</Text>
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.centered}>
        <Ionicons name="warning-outline" size={28} color={theme.colors.moss} />
        <Text style={styles.centerTitle}>{state.error}</Text>
        <Text style={styles.centerBody}>Refresh the workspace or check your selected runtime.</Text>
        <Pressable accessibilityRole="button" onPress={onRefresh} style={styles.retryButton}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const summary = state.summary;
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.forest} />}
    >
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="sparkles-outline" size={22} color={theme.colors.forest} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>Agent workspace</Text>
          <Text style={styles.subtitle}>{summary.runtime.label}</Text>
        </View>
      </View>

      <Section title="Providers" count={summary.providers.length}>
        {summary.providers.length === 0 ? <EmptyText>No providers are ready.</EmptyText> : null}
        {summary.providers.map((provider) => (
          <View key={provider.id} style={styles.row}>
            <View style={styles.rowIcon}>
              <Ionicons name="cube-outline" size={18} color={theme.colors.moss} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{provider.displayName}</Text>
              <Text style={styles.rowSubtitle}>{provider.availability.replace(/_/g, " ")}</Text>
            </View>
            <Text style={styles.rowMeta}>{provider.authStatus.replace(/_/g, " ")}</Text>
          </View>
        ))}
      </Section>

      <Section title="Active Threads" count={summary.activeThreads.items.length}>
        {summary.activeThreads.items.length === 0 ? <EmptyText>No active threads.</EmptyText> : null}
        {summary.activeThreads.items.map((thread) => (
          <View key={thread.id} style={styles.row}>
            <View style={styles.rowIcon}>
              <Ionicons name="git-branch-outline" size={18} color={theme.colors.moss} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{thread.title}</Text>
              <Text style={styles.rowSubtitle}>{thread.providerId}</Text>
            </View>
            <Text style={styles.rowMeta}>{thread.status.replace(/_/g, " ")}</Text>
          </View>
        ))}
      </Section>

      <Section title="Terminals" count={summary.terminalSessions.items.length}>
        {summary.terminalSessions.items.length === 0 ? <EmptyText>No terminal sessions.</EmptyText> : null}
        {summary.terminalSessions.items.map((session) => (
          <View key={session.id} style={styles.row}>
            <View style={styles.rowIcon}>
              <Ionicons name="terminal-outline" size={18} color={theme.colors.moss} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{session.name}</Text>
              <Text style={styles.rowSubtitle}>{session.attachable ? "Attachable" : "Unavailable"}</Text>
            </View>
            <Text style={styles.rowMeta}>{session.status}</Text>
          </View>
        ))}
      </Section>
    </ScrollView>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionCount}>{count}</Text>
      </View>
      {children}
    </View>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <Text style={styles.emptyText}>{children}</Text>;
}

const styles = StyleSheet.create((theme, rt) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingTop: rt.insets.top + theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: rt.insets.bottom + 32,
    gap: theme.spacing.lg,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  centerTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 17,
    color: theme.colors.foreground,
  },
  centerBody: {
    maxWidth: 280,
    textAlign: "center",
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    color: theme.colors.mutedForeground,
  },
  retryButton: {
    minHeight: 40,
    borderRadius: 20,
    paddingHorizontal: theme.spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.forest,
  },
  retryText: {
    fontFamily: theme.fonts.sansSemiBold,
    color: theme.colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  headerIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: theme.fonts.displaySemiBold,
    fontSize: 24,
    color: theme.colors.foreground,
  },
  subtitle: {
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    color: theme.colors.mutedForeground,
  },
  section: {
    gap: theme.spacing.sm,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 14,
    color: theme.colors.foreground,
  },
  sectionCount: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  row: {
    minHeight: 68,
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  rowSubtitle: {
    marginTop: 2,
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
    textTransform: "capitalize",
  },
  rowMeta: {
    maxWidth: 108,
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
    color: theme.colors.moss,
    textTransform: "capitalize",
  },
  emptyText: {
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    fontFamily: theme.fonts.sans,
    color: theme.colors.mutedForeground,
  },
}));
