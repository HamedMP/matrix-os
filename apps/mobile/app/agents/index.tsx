import { useEffect } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { RuntimeSummary } from "@matrix-os/contracts";
import { useGateway } from "@/app/_layout";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { AgentCockpit } from "@/components/agent-cockpit";
import { AgentProjectList } from "@/components/agents/agent-project-workspace-screen";
import { AGENT_WORKSPACE_CONNECTION_LABELS, capabilityEnabled } from "@/components/agents/agent-workspace-shared";
import { useRuntimeSummary } from "@/lib/use-runtime-summary";
import { capture } from "@/lib/analytics";
import { routedReviewIdParam } from "./reviews";

type NavCard = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  accessibilityLabel: string;
  route: "/agents/providers" | "/agents/reviews" | "/agents/terminals";
  badge: number | null;
};

function navCardsForSummary(summary: RuntimeSummary): NavCard[] {
  return [
    {
      key: "providers",
      label: "Providers",
      icon: "construct-outline",
      accessibilityLabel: "Open providers",
      route: "/agents/providers",
      badge: summary.providers.length,
    },
    {
      key: "reviews",
      label: "Reviews",
      icon: "git-pull-request-outline",
      accessibilityLabel: "Open reviews",
      route: "/agents/reviews",
      badge: null,
    },
    {
      key: "terminals",
      label: "Terminals",
      icon: "terminal-outline",
      accessibilityLabel: "Open terminals",
      route: "/agents/terminals",
      badge: summary.terminalSessions.items.length,
    },
  ];
}

export default function AgentsScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const routeParams = useLocalSearchParams<{ reviewId?: string | string[] }>();
  const routedReviewId = routedReviewIdParam(routeParams.reviewId);
  const { client, connectionState } = useGateway();
  const { state, refreshing, onRefresh } = useRuntimeSummary();

  // Existing notification links target /agents?reviewId=<id>; the reviews UI now
  // lives on a dedicated screen, so forward valid review deep links there.
  useEffect(() => {
    if (!routedReviewId) return;
    router.replace({ pathname: "/agents/reviews", params: { reviewId: routedReviewId } } as never);
  }, [routedReviewId, router]);

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
  const canCreate = capabilityEnabled(summary, "codingAgentsThreadCreate");
  const navCards = navCardsForSummary(summary);
  return (
    <ScrollView
      style={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      accessibilityLabel="Refresh agent workspace"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.forest} />}
    >
      <ConnectionBanner
        state={connectionState}
        queueCount={0}
        onRetry={() => client?.connect()}
        labels={AGENT_WORKSPACE_CONNECTION_LABELS}
      />
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="sparkles-outline" size={22} color={theme.colors.forest} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>Agent workspace</Text>
          <Text style={styles.subtitle}>{summary.runtime.label}</Text>
        </View>
      </View>

      <AgentCockpit
        summary={summary}
        canCreate={canCreate}
        onCreate={() => {
          const defaultProjectId = summary.projects.items[0]?.id;
          if (defaultProjectId) {
            router.push({ pathname: "/agents/new", params: { projectId: defaultProjectId } } as never);
            return;
          }
          router.push("/agents/new");
        }}
        onCreateInProject={(projectId) => router.push({ pathname: "/agents/new", params: { projectId } } as never)}
        onOpenThread={(thread) => {
          capture("agent_thread_opened");
          router.push(`/agents/${thread.id}` as any);
        }}
      />

      {capabilityEnabled(summary, "codingAgentsProjectWorkspace")
        && capabilityEnabled(summary, "codingAgentsConversationView") ? (
          <AgentProjectList
            summary={summary}
            onOpenProject={(projectId) => {
              router.push({
                pathname: "/agents/projects/[projectId]",
                params: { projectId },
              } as never);
            }}
          />
        ) : null}

      <View style={styles.navRow}>
        {navCards.map((card) => (
          <Pressable
            key={card.key}
            accessibilityRole="button"
            accessibilityLabel={card.accessibilityLabel}
            onPress={() => router.push(card.route)}
            style={({ pressed }) => [styles.navCard, pressed ? styles.navCardPressed : null]}
          >
            <View style={styles.navCardIcon}>
              <Ionicons name={card.icon} size={20} color={theme.colors.moss} />
            </View>
            <Text style={styles.navCardLabel}>{card.label}</Text>
            {card.badge !== null ? <Text style={styles.navCardBadge}>{card.badge}</Text> : null}
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingTop: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: 32,
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
  navRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  navCard: {
    flex: 1,
    minHeight: 88,
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  navCardPressed: {
    opacity: 0.82,
  },
  navCardIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  navCardLabel: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 14,
    color: theme.colors.foreground,
  },
  navCardBadge: {
    position: "absolute",
    top: theme.spacing.md,
    right: theme.spacing.md,
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 11,
    overflow: "hidden",
    textAlign: "center",
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.mutedForeground,
    backgroundColor: theme.colors.secondary,
  },
}));
