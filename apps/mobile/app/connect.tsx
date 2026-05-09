import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useGateway } from "./_layout";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { colors, fonts, radius, spacing } from "@/lib/theme";

export default function ConnectScreen() {
  const router = useRouter();
  const { connectionState } = useGateway();

  return (
    <View style={styles.container}>
      <View style={styles.iconShell}>
        <Ionicons name="cloud-done-outline" size={34} color={colors.light.forest} />
      </View>
      <Text style={styles.title}>Matrix OS Cloud</Text>
      <Text style={styles.description}>
        This mobile app connects to your hosted Matrix OS at app.matrix-os.com.
      </Text>
      <View style={styles.statusRow}>
        <View style={styles.statusDot} />
        <Text selectable style={styles.statusText}>
          {HOSTED_GATEWAY_URL.replace(/^https?:\/\//, "")}
        </Text>
        <Text style={styles.statusPill}>{connectionState}</Text>
      </View>
      <Pressable
        onPress={() => router.replace("/(tabs)/apps" as any)}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Ionicons name="apps" size={17} color={colors.light.primaryForeground} />
        <Text style={styles.buttonText}>Open Apps</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    backgroundColor: colors.light.background,
  },
  iconShell: {
    width: 82,
    height: 82,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.secondary,
    marginBottom: spacing.lg,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 26,
    color: colors.light.foreground,
  },
  description: {
    maxWidth: 280,
    marginTop: spacing.sm,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    color: colors.light.mutedForeground,
  },
  statusRow: {
    minHeight: 42,
    marginTop: spacing.xl,
    marginBottom: spacing.xl,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    borderRadius: radius.full,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.light.primary,
  },
  statusText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
    color: colors.light.foreground,
  },
  statusPill: {
    overflow: "hidden",
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: colors.light.forest,
    backgroundColor: colors.light.secondary,
  },
  button: {
    minHeight: 48,
    minWidth: 160,
    borderRadius: radius.full,
    borderCurve: "continuous" as const,
    backgroundColor: colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    boxShadow: "0 12px 24px rgba(50, 61, 46, 0.16)",
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  buttonText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
    color: colors.light.primaryForeground,
  },
});
