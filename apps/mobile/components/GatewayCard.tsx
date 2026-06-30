import { View, Text, Pressable, Alert } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import type { GatewayConnection } from "@/lib/storage";

interface GatewayCardProps {
  gateway: GatewayConnection;
  onSelect: () => void;
  onRemove: () => void;
}

export function GatewayCard({ gateway, onSelect, onRemove }: GatewayCardProps) {
  const { theme } = useUnistyles();
  const handleLongPress = () => {
    Alert.alert("Remove Gateway", `Remove "${gateway.name}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: onRemove },
    ]);
  };

  return (
    <Pressable
      onPress={onSelect}
      onLongPress={handleLongPress}
      style={({ pressed }) => [
        styles.card,
        pressed && styles.cardPressed,
      ]}
    >
      <View style={styles.row}>
        <View style={styles.iconContainer}>
          <Ionicons name="server-outline" size={18} color={theme.colors.primary} />
        </View>
        <View style={styles.textContainer}>
          <Text style={styles.name}>{gateway.name}</Text>
          <Text style={styles.url}>{gateway.url}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={theme.colors.mutedForeground} />
      </View>
      {gateway.token && (
        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Ionicons name="lock-closed" size={10} color={theme.colors.primary} />
            <Text style={styles.badgeText}>Authenticated</Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginBottom: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.04)",
  },
  cardPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.98 }],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.sm,
    borderCurve: "continuous" as const,
    backgroundColor: theme.colors.secondary,
    alignItems: "center",
    justifyContent: "center",
  },
  textContainer: {
    flex: 1,
  },
  name: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  url: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    color: theme.colors.mutedForeground,
    marginTop: 2,
  },
  badgeRow: {
    flexDirection: "row",
    marginTop: theme.spacing.sm,
    marginLeft: 48,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: theme.radius.full,
    backgroundColor: "rgba(194, 112, 58, 0.1)",
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
  },
  badgeText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 11,
    color: theme.colors.primary,
  },
}));
