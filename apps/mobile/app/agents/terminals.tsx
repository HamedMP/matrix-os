import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { PreviewSessionSummary, RuntimeSummary } from "@matrix-os/contracts";
import { EmptyText, Section, capabilityEnabled } from "@/components/agents/agent-workspace-shared";
import { useRuntimeSummary } from "@/lib/use-runtime-summary";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";
import { isSafeShellSessionName } from "@/lib/terminal-state";

type SummaryTerminalSession = RuntimeSummary["terminalSessions"]["items"][number];
type TerminalOpenError = "Terminal session unavailable. Try again.";

export default function TerminalsScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [terminalOpenError, setTerminalOpenError] = useState<TerminalOpenError | null>(null);
  const { state, refreshing, onRefresh } = useRuntimeSummary();

  const openTerminalSession = useCallback(async (session: SummaryTerminalSession) => {
    setTerminalOpenError(null);
    if (!isSafeShellSessionName(session.name)) {
      setTerminalOpenError("Terminal session unavailable. Try again.");
      return;
    }
    try {
      const savedState = await loadMobileShellState();
      await saveMobileShellState({
        ...savedState,
        mode: "terminal",
        lastActiveTerminalSessionId: session.name,
        terminalHandoffSessionId: session.name,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      console.warn("[mobile] failed to remember recent terminal session");
      setTerminalOpenError("Terminal session unavailable. Try again.");
      return;
    }
    router.push("/terminal");
  }, [router]);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: "Terminals" }} />
        <ActivityIndicator color={theme.colors.forest} />
        <Text style={styles.centerTitle}>Loading workspace...</Text>
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: "Terminals" }} />
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
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      accessibilityLabel="Refresh agent terminals"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.forest} />}
    >
      <Stack.Screen options={{ title: "Terminals" }} />
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="terminal-outline" size={22} color={theme.colors.forest} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>Terminals</Text>
          <Text style={styles.subtitle}>{summary.runtime.label}</Text>
        </View>
      </View>

      <Section title="Terminals" count={summary.terminalSessions.items.length}>
        {summary.terminalSessions.items.length === 0 ? <EmptyText>No terminal sessions.</EmptyText> : null}
        {summary.terminalSessions.items.map((session) => {
          const canOpenTerminal = session.attachable && session.status === "running";
          return (
            <Pressable
              key={session.id}
              accessibilityRole={canOpenTerminal ? "button" : undefined}
              accessibilityLabel={canOpenTerminal
                ? `Open terminal session ${session.name}`
                : `Terminal session ${session.name} unavailable`}
              accessibilityState={canOpenTerminal ? undefined : { disabled: true }}
              disabled={!canOpenTerminal}
              onPress={() => void openTerminalSession(session)}
              style={({ pressed }) => [
                styles.row,
                pressed ? styles.rowPressed : null,
              ]}
            >
              <View style={styles.rowIcon}>
                <Ionicons name="terminal-outline" size={18} color={theme.colors.moss} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{session.name}</Text>
                <Text style={styles.rowSubtitle}>{canOpenTerminal ? "Attachable" : "Unavailable"}</Text>
              </View>
              <Text style={styles.rowMeta}>{session.status}</Text>
            </Pressable>
          );
        })}
        {terminalOpenError ? <Text style={styles.terminalError}>{terminalOpenError}</Text> : null}
      </Section>

      {capabilityEnabled(summary, "codingAgentsPreview") ? (
        <PreviewSection
          summary={summary}
          onOpenPreview={(preview) => {
            router.push({
              pathname: "/agents/preview",
              params: {
                id: preview.id,
              },
            });
          }}
        />
      ) : null}
    </ScrollView>
  );
}

function PreviewSection({
  summary,
  onOpenPreview,
}: {
  summary: RuntimeSummary;
  onOpenPreview: (preview: PreviewSessionSummary) => void;
}) {
  const { theme } = useUnistyles();
  const previews = summary.previewSessions ?? { items: [], hasMore: false, limit: 50 };

  return (
    <Section title="Previews" count={previews.items.length}>
      {previews.items.length === 0 ? <EmptyText>No previews.</EmptyText> : null}
      {previews.items.map((preview) => (
        <Pressable
          key={preview.id}
          accessibilityRole="button"
          accessibilityLabel={`Open preview ${preview.label}`}
          onPress={() => onOpenPreview(preview)}
          style={({ pressed }) => [
            styles.row,
            pressed ? styles.rowPressed : null,
          ]}
        >
          <View style={styles.rowIcon}>
            <Ionicons name="browsers-outline" size={18} color={theme.colors.moss} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{preview.label}</Text>
            <Text style={styles.rowSubtitle}>{preview.origin ?? "No local origin"}</Text>
          </View>
          <Text style={styles.rowMeta}>{preview.status}</Text>
        </Pressable>
      ))}
    </Section>
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
  rowPressed: {
    opacity: 0.82,
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
  terminalError: {
    padding: theme.spacing.sm,
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.destructive,
  },
}));
