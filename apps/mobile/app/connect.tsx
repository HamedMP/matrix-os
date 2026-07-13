import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useGateway } from "./_layout";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export default function ConnectScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { connectionState } = useGateway();

  return (
    <View style={styles.container}>
      <View style={styles.iconShell}>
        <Ionicons name="cloud-done-outline" size={34} color={theme.colors.forest} />
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
        <Ionicons name="apps" size={17} color={theme.colors.primaryForeground} />
        <Text style={styles.buttonText}>Open Apps</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  iconShell: {
    width: 82,
    height: 82,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.secondary,
    marginBottom: theme.spacing.lg,
  },
  title: {
    fontFamily: theme.fonts.sansBold,
    fontSize: 26,
    color: theme.colors.foreground,
  },
  description: {
    maxWidth: 280,
    marginTop: theme.spacing.sm,
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    color: theme.colors.mutedForeground,
  },
  statusRow: {
    minHeight: 42,
    marginTop: theme.spacing.xl,
    marginBottom: theme.spacing.xl,
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.sm,
    borderRadius: theme.radius.full,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.primary,
  },
  statusText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  statusPill: {
    overflow: "hidden",
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
    fontFamily: theme.fonts.sansMedium,
    fontSize: 11,
    color: theme.colors.forest,
    backgroundColor: theme.colors.secondary,
  },
  button: {
    minHeight: 48,
    minWidth: 160,
    borderRadius: theme.radius.full,
    borderCurve: "continuous" as const,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xl,
    boxShadow: "0 12px 24px rgba(50, 61, 46, 0.16)",
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  buttonText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.primaryForeground,
  },
}));
