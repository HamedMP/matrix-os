import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import type { ConnectionState } from "@/lib/gateway-client";

interface ConnectionBannerProps {
  state: ConnectionState;
  queueCount: number;
  onRetry?: () => void;
  labels?: Partial<Record<Exclude<ConnectionState, "connected">, string>>;
}

const STATE_CONFIG: Record<ConnectionState, { label: string; icon: keyof typeof Ionicons.glyphMap } | null> = {
  connected: null,
  connecting: { label: "Connecting to Matrix OS", icon: "sync-outline" },
  disconnected: { label: "Chat socket offline", icon: "cloud-offline-outline" },
  error: { label: "Chat reconnecting", icon: "radio-outline" },
};

export function ConnectionBanner({ state, queueCount, onRetry, labels }: ConnectionBannerProps) {
  const { theme } = useUnistyles();
  if (state === "connected") return null;
  const config = STATE_CONFIG[state]!;
  const label = labels?.[state] ?? config.label;

  return (
    <View style={styles.container}>
      <Ionicons name={config.icon} size={14} color={theme.colors.forest} />
      <Text style={styles.label}>
        {label}
        {queueCount > 0 ? ` (${queueCount} queued)` : ""}
      </Text>
      {state === "error" && onRetry && (
        <Pressable onPress={onRetry} style={styles.retryButton}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: theme.spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.secondary,
  },
  label: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
    color: theme.colors.forest,
  },
  retryButton: {
    marginLeft: theme.spacing.sm,
    borderRadius: 4,
    borderCurve: "continuous" as const,
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
  },
  retryText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 11,
    color: theme.colors.forest,
  },
}));
