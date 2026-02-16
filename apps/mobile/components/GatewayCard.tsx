import { View, Text, Pressable, Alert, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, fonts, spacing, radius } from "@/lib/theme";
import type { GatewayConnection } from "@/lib/storage";

interface GatewayCardProps {
  gateway: GatewayConnection;
  onSelect: () => void;
  onRemove: () => void;
}

export function GatewayCard({ gateway, onSelect, onRemove }: GatewayCardProps) {
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
          <Ionicons name="server-outline" size={18} color={colors.light.primary} />
        </View>
        <View style={styles.textContainer}>
          <Text style={styles.name}>{gateway.name}</Text>
          <Text style={styles.url}>{gateway.url}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.light.mutedForeground} />
      </View>
      {gateway.token && (
        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Ionicons name="lock-closed" size={10} color={colors.light.primary} />
            <Text style={styles.badgeText}>Authenticated</Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  cardPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.98 }],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.light.secondary,
    alignItems: "center",
    justifyContent: "center",
  },
  textContainer: {
    flex: 1,
  },
  name: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
    color: colors.light.foreground,
  },
  url: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.light.mutedForeground,
    marginTop: 2,
  },
  badgeRow: {
    flexDirection: "row",
    marginTop: spacing.sm,
    marginLeft: 48,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: radius.full,
    backgroundColor: "rgba(194, 112, 58, 0.1)",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  badgeText: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: colors.light.primary,
  },
});
