import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { RuntimeSummary } from "@matrix-os/contracts";

export type ScreenState =
  | { status: "loading"; summary: null; error: null }
  | { status: "ready"; summary: RuntimeSummary; error: null }
  | { status: "error"; summary: null; error: "Runtime summary unavailable" };

export const INITIAL_STATE: ScreenState = { status: "loading", summary: null, error: null };

export const AGENT_WORKSPACE_CONNECTION_LABELS = {
  connecting: "Connecting to agent workspace",
  disconnected: "Agent workspace offline",
  error: "Agent workspace reconnecting",
} as const;

export function capabilityEnabled(summary: RuntimeSummary, id: string): boolean {
  return summary.capabilities.some((capability) => capability.id === id && capability.enabled);
}

export function canOpenExternalUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
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

export function EmptyText({ children }: { children: ReactNode }) {
  return <Text style={styles.emptyText}>{children}</Text>;
}

const styles = StyleSheet.create((theme) => ({
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
