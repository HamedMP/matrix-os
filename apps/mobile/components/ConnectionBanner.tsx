import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ConnectionState } from "@/lib/gateway-client";
import { colors, fonts, spacing } from "@/lib/theme";

interface ConnectionBannerProps {
  state: ConnectionState;
  queueCount: number;
  onRetry?: () => void;
}

const STATE_CONFIG: Record<ConnectionState, { label: string; icon: keyof typeof Ionicons.glyphMap; color: string } | null> = {
  connected: null,
  connecting: { label: "Connecting...", icon: "sync-outline", color: colors.light.warning },
  disconnected: { label: "No connection", icon: "cloud-offline-outline", color: colors.light.destructive },
  error: { label: "Connection error", icon: "warning-outline", color: colors.light.destructive },
};

export function ConnectionBanner({ state, queueCount, onRetry }: ConnectionBannerProps) {
  const config = STATE_CONFIG[state];
  if (!config) return null;

  return (
    <View style={[styles.container, { backgroundColor: config.color }]}>
      <Ionicons name={config.icon} size={14} color="#ffffff" />
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
  },
  label: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: "#ffffff",
  },
  retryButton: {
    marginLeft: spacing.sm,
    borderRadius: 4,
    borderCurve: "continuous" as const,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  retryText: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: "#ffffff",
  },
});
