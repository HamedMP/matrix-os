import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import { buildAgentCockpit } from "@/lib/agent-cockpit";

type AgentCockpitProps = {
  summary: Pick<RuntimeSummary, "activeThreads" | "attentionThreads">;
  canCreate: boolean;
  onCreate: () => void;
  onOpenThread: (thread: AgentThreadSummary) => void;
};

function attentionCopy(thread: AgentThreadSummary): {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
} {
  if (thread.attention === "approval_required" || thread.status === "waiting_for_approval") {
    return { label: "Approval needed", icon: "hand-left-outline" };
  }
  if (thread.attention === "input_required" || thread.status === "waiting_for_input") {
    return { label: "Input needed", icon: "chatbubble-ellipses-outline" };
  }
  return { label: "Failed", icon: "warning-outline" };
}

function statusLabel(status: AgentThreadSummary["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    default:
      return status.replace(/_/g, " ");
  }
}

function triggerSelectionHaptic(): void {
  if (process.env.EXPO_OS !== "ios" || typeof Haptics.selectionAsync !== "function") return;
  void Haptics.selectionAsync().catch((error: unknown) => {
    console.warn("[mobile] selection haptic unavailable", error instanceof Error ? error.name : "unknown");
  });
}

function SectionHeading({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
    </View>
  );
}

function ThreadRow({
  thread,
  attention,
  recent,
  onPress,
  last,
}: {
  thread: AgentThreadSummary;
  attention: boolean;
  recent?: boolean;
  onPress: () => void;
  last: boolean;
}) {
  const { theme } = useUnistyles();
  const attentionState = attention ? attentionCopy(thread) : null;
  const label = attentionState?.label ?? statusLabel(thread.status);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={attentionState
        ? `Open thread ${thread.title}, ${attentionState.label}`
        : `Open thread ${thread.title}`}
      onPress={() => {
        triggerSelectionHaptic();
        onPress();
      }}
      style={({ pressed }) => [
        styles.threadRow,
        !last ? styles.threadRowBorder : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <View style={[styles.threadIcon, attentionState ? styles.attentionIcon : null]}>
        <Ionicons
          name={attentionState?.icon ?? "sparkles-outline"}
          size={17}
          color={attentionState ? theme.colors.glow : theme.colors.moss}
        />
      </View>
      <View style={styles.threadText}>
        <Text numberOfLines={2} style={styles.threadTitle}>{thread.title}</Text>
        <Text numberOfLines={1} style={styles.threadMeta}>{`${thread.providerId} · ${label}`}</Text>
      </View>
      {attentionState ? (
        <View style={styles.attentionDot} />
      ) : (
        <View testID={`agent-thread-status-${thread.id}`} style={styles.staticStatus}>
          <Ionicons
            name={recent ? "time-outline" : "ellipse"}
            size={recent ? 17 : 9}
            color={recent ? theme.colors.mutedForeground : theme.colors.moss}
          />
        </View>
      )}
    </Pressable>
  );
}

export function AgentCockpit({ summary, canCreate, onCreate, onOpenThread }: AgentCockpitProps) {
  const { theme } = useUnistyles();
  const model = buildAgentCockpit(summary);

  return (
    <View style={styles.cockpit}>
      {canCreate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a new agent run"
          onPress={() => {
            triggerSelectionHaptic();
            onCreate();
          }}
          style={({ pressed }) => [styles.quickStart, pressed ? styles.pressed : null]}
        >
          <View style={styles.quickStartIcon}>
            <Ionicons name="sparkles-outline" size={19} color={theme.colors.background} />
          </View>
          <View style={styles.quickStartText}>
            <Text style={styles.quickStartTitle}>What do you want Matrix to build?</Text>
            <Text style={styles.quickStartSubtitle}>Start a focused agent run</Text>
          </View>
          <View style={styles.quickStartAction}>
            <Ionicons name="arrow-up" size={18} color={theme.colors.background} />
          </View>
        </Pressable>
      ) : null}

      {model.needsAttention.length > 0 ? (
        <View style={styles.section}>
          <SectionHeading title="Needs attention" count={model.needsAttention.length} />
          <View style={styles.threadGroup}>
            {model.needsAttention.map((thread, index) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                attention
                last={index === model.needsAttention.length - 1}
                onPress={() => onOpenThread(thread)}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeading title="Working" count={model.working.length} />
        {model.working.length > 0 ? (
          <View style={styles.threadGroup}>
            {model.working.map((thread, index) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                attention={false}
                last={index === model.working.length - 1}
                onPress={() => onOpenThread(thread)}
              />
            ))}
          </View>
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="checkmark-circle-outline" size={20} color={theme.colors.moss} />
            <Text style={styles.emptyTitle}>No active agent runs.</Text>
            <Text style={styles.emptyBody}>Start a run when you are ready.</Text>
          </View>
        )}
      </View>

      {model.recent.length > 0 ? (
        <View style={styles.section}>
          <SectionHeading title="Recent" count={model.recent.length} />
          <View style={styles.threadGroup}>
            {model.recent.map((thread, index) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                attention={false}
                recent
                last={index === model.recent.length - 1}
                onPress={() => onOpenThread(thread)}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  cockpit: {
    gap: theme.spacing.lg,
  },
  quickStart: {
    minHeight: 78,
    borderRadius: 20,
    borderCurve: "continuous" as const,
    padding: theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    backgroundColor: theme.colors.forest,
    boxShadow: theme.shadows.raised,
  },
  quickStartIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    borderCurve: "continuous" as const,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.12)",
  },
  quickStartText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  quickStartTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.background,
  },
  quickStartSubtitle: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: "rgba(250, 250, 249, 0.68)",
  },
  quickStartAction: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.12)",
  },
  section: {
    gap: theme.spacing.sm,
  },
  sectionHeading: {
    minHeight: 22,
    paddingHorizontal: theme.spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    letterSpacing: 0.1,
    color: theme.colors.foreground,
  },
  sectionCount: {
    minWidth: 24,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: "hidden",
    textAlign: "center",
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.mutedForeground,
    backgroundColor: theme.colors.field,
    fontVariant: ["tabular-nums"] as const,
  },
  threadGroup: {
    borderRadius: 18,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    backgroundColor: theme.colors.card,
    boxShadow: theme.shadows.sm,
  },
  threadRow: {
    minHeight: 66,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  threadRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  threadIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    borderCurve: "continuous" as const,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.field,
  },
  attentionIcon: {
    backgroundColor: "rgba(208, 111, 37, 0.10)",
  },
  threadText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  threadTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  threadMeta: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
    textTransform: "capitalize",
  },
  attentionDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: theme.colors.glow,
  },
  staticStatus: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: {
    minHeight: 78,
    borderRadius: 18,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.card,
  },
  emptyTitle: {
    paddingTop: theme.spacing.xs,
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  emptyBody: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  pressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
}));
