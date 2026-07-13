import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { colors } from "@/lib/theme";

interface ChannelBadgeProps {
  name: string;
  status: "connected" | "degraded" | "error" | "not_configured";
}

const STATUS_STYLES: Record<string, { color: string; label: string }> = {
  connected: { color: colors.light.success, label: "Connected" },
  degraded: { color: colors.light.warning, label: "Degraded" },
  error: { color: colors.light.destructive, label: "Error" },
  not_configured: { color: colors.light.mutedForeground, label: "Not configured" },
};

export function ChannelBadge({ name, status }: ChannelBadgeProps) {
  const info = STATUS_STYLES[status] ?? STATUS_STYLES.not_configured;

  return (
    <View style={styles.container}>
      <Text style={styles.name}>{name}</Text>
      <View style={styles.statusRow}>
        <View style={[styles.dot, { backgroundColor: info.color }]} />
        <Text style={styles.label}>{info.label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  name: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.foreground,
    textTransform: "capitalize",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
}));
