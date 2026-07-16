import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import { buildAgentCockpit, formatRelativeAge, type AgentCockpitProjectGroup } from "@/lib/agent-cockpit";

type AgentCockpitProps = {
  summary: Pick<RuntimeSummary, "activeThreads" | "attentionThreads" | "projects">;
  canCreate: boolean;
  onCreate: () => void;
  onCreateInProject?: (projectId: string) => void;
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

function isWorking(thread: AgentThreadSummary): boolean {
  return thread.status === "queued" || thread.status === "starting" || thread.status === "running";
}

function ThreadRow({
  thread,
  attention,
  nowMs,
  onPress,
  last,
}: {
  thread: AgentThreadSummary;
  attention: boolean;
  nowMs: number;
  onPress: () => void;
  last: boolean;
}) {
  const { theme } = useUnistyles();
  const attentionState = attention ? attentionCopy(thread) : null;
  const working = !attentionState && isWorking(thread);
  const label = attentionState?.label ?? statusLabel(thread.status);
  const age = formatRelativeAge(thread.updatedAt, nowMs);
  const meta = age ? `${thread.providerId} · ${label} · ${age}` : `${thread.providerId} · ${label}`;

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
        <Text numberOfLines={1} style={styles.threadMeta}>{meta}</Text>
      </View>
      {attentionState ? (
        <View style={styles.attentionDot} />
      ) : (
        <View testID={`agent-thread-status-${thread.id}`} style={styles.staticStatus}>
          <Ionicons
            name={working ? "ellipse" : "time-outline"}
            size={working ? 9 : 17}
            color={working ? theme.colors.moss : theme.colors.mutedForeground}
          />
        </View>
      )}
    </Pressable>
  );
}

function ProjectGroupSection({
  group,
  canCreate,
  nowMs,
  onCreateInProject,
  onOpenThread,
}: {
  group: AgentCockpitProjectGroup;
  canCreate: boolean;
  nowMs: number;
  onCreateInProject?: (projectId: string) => void;
  onOpenThread: (thread: AgentThreadSummary) => void;
}) {
  const { theme } = useUnistyles();
  const canCreateHere = canCreate && group.projectId !== null && typeof onCreateInProject === "function";

  return (
    <View style={styles.section} testID={`agent-project-group-${group.projectId ?? "none"}`}>
      <View style={styles.sectionHeading}>
        <View style={styles.projectHeadingText}>
          <Text numberOfLines={1} style={styles.sectionTitle}>{group.label}</Text>
          {group.workingCount > 0 ? (
            <Text style={styles.projectWorkingBadge}>{`${group.workingCount} working`}</Text>
          ) : null}
          {group.attentionCount > 0 ? (
            <View style={styles.projectAttentionBadge}>
              <View style={styles.attentionDot} />
              <Text style={styles.projectAttentionCount}>{group.attentionCount}</Text>
            </View>
          ) : null}
        </View>
        {canCreateHere ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Start a chat in ${group.label}`}
            onPress={() => {
              triggerSelectionHaptic();
              onCreateInProject?.(group.projectId as string);
            }}
            style={({ pressed }) => [styles.projectNewButton, pressed ? styles.pressed : null]}
          >
            <Ionicons name="add" size={16} color={theme.colors.forest} />
          </Pressable>
        ) : (
          <Text style={styles.sectionCount}>{group.threads.length}</Text>
        )}
      </View>
      {group.threads.length > 0 ? (
        <View style={styles.threadGroup}>
          {group.threads.map((thread, index) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              attention={false}
              nowMs={nowMs}
              last={index === group.threads.length - 1}
              onPress={() => onOpenThread(thread)}
            />
          ))}
        </View>
      ) : (
        <View style={styles.emptyState}>
          <Ionicons name="folder-open-outline" size={20} color={theme.colors.moss} />
          <Text style={styles.emptyTitle}>No chats yet.</Text>
          <Text style={styles.emptyBody}>
            {canCreateHere ? "Start a chat to work in this project." : "Runs in this project will appear here."}
          </Text>
        </View>
      )}
    </View>
  );
}

// Relative ages tick once a minute; reading the clock in an effect keeps
// render pure for the React Compiler.
function useNowMs(intervalMs = 60_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

export function AgentCockpit({ summary, canCreate, onCreate, onCreateInProject, onOpenThread }: AgentCockpitProps) {
  const { theme } = useUnistyles();
  const model = buildAgentCockpit(summary);
  const nowMs = useNowMs();

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
                nowMs={nowMs}
                last={index === model.needsAttention.length - 1}
                onPress={() => onOpenThread(thread)}
              />
            ))}
          </View>
        </View>
      ) : null}

      {model.projects.length > 0 ? (
        model.projects.map((group) => (
          <ProjectGroupSection
            key={group.projectId ?? "__no_project__"}
            group={group}
            canCreate={canCreate}
            nowMs={nowMs}
            onCreateInProject={onCreateInProject}
            onOpenThread={onOpenThread}
          />
        ))
      ) : model.needsAttention.length === 0 ? (
        <View style={styles.section}>
          <View style={styles.emptyState}>
            <Ionicons name="checkmark-circle-outline" size={20} color={theme.colors.moss} />
            <Text style={styles.emptyTitle}>No projects or agent runs yet.</Text>
            <Text style={styles.emptyBody}>Start a run when you are ready.</Text>
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
  projectHeadingText: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  projectWorkingBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: "hidden",
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.forest,
    backgroundColor: theme.colors.field,
  },
  projectAttentionBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  projectAttentionCount: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.glow,
    fontVariant: ["tabular-nums"] as const,
  },
  projectNewButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
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
