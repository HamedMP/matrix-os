import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ConnectionState } from "@/lib/gateway-client";
import { colors, fonts, spacing } from "@/lib/theme";

interface ConnectionBannerProps {
  state: ConnectionState;
  queueCount: number;
  onRetry?: () => void;
}

const STATE_CONFIG: Record<ConnectionState, { label: string; icon: keyof typeof Ionicons.glyphMap } | null> = {
  connected: null,
  connecting: { label: "Connecting to Matrix OS", icon: "sync-outline" },
  disconnected: { label: "Chat socket offline", icon: "cloud-offline-outline" },
  error: { label: "Chat reconnecting", icon: "radio-outline" },
};

export function ConnectionBanner({ state, queueCount, onRetry }: ConnectionBannerProps) {
  const config = STATE_CONFIG[state];
  if (!config) return null;

  return (
    <View style={styles.container}>
      <Ionicons name={config.icon} size={14} color={colors.light.forest} />
      <Text style={styles.label}>
        {config.label}
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

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.light.border,
    backgroundColor: colors.light.secondary,
  },
  label: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: colors.light.forest,
  },
  retryButton: {
    marginLeft: spacing.sm,
    borderRadius: 4,
    borderCurve: "continuous" as const,
    backgroundColor: colors.light.card,
    borderWidth: 1,
    borderColor: colors.light.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  retryText: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: colors.light.forest,
  },
});
