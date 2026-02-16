import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useGateway } from "./_layout";
import { useEffect } from "react";
import { colors, fonts, spacing, radius } from "@/lib/theme";

export default function Index() {
  const { gateway } = useGateway();
  const router = useRouter();

  useEffect(() => {
    if (gateway) {
      router.replace("/(tabs)/chat");
    }
  }, [gateway, router]);

  if (gateway) {
    return null;
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.heroSection}>
          <View style={styles.iconContainer}>
            <Ionicons name="grid" size={48} color={colors.light.primary} />
          </View>
          <Text style={styles.title}>Matrix OS</Text>
          <Text style={styles.subtitle}>Your AI operating system</Text>
          <Text style={styles.description}>
            Connect to your Matrix OS gateway to chat with AI, manage tasks, and control your digital life.
          </Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={() => router.push("/connect")}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Ionicons name="link" size={20} color={colors.light.primaryForeground} />
            <Text style={styles.primaryButtonText}>Connect to Gateway</Text>
          </Pressable>

          <Pressable
            onPress={() => {}}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Ionicons name="person-circle-outline" size={20} color={colors.light.foreground} />
            <Text style={styles.secondaryButtonText}>Sign in with Clerk</Text>
          </Pressable>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>matrix-os.com</Text>
          <Text style={styles.versionText}>v0.3.0</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    justifyContent: "center",
  },
  heroSection: {
    alignItems: "center",
    marginBottom: 48,
  },
  iconContainer: {
    width: 96,
    height: 96,
    borderRadius: 24,
    backgroundColor: colors.light.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xl,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 32,
    color: colors.light.foreground,
    letterSpacing: -0.5,
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontFamily: fonts.sansMedium,
    fontSize: 16,
    color: colors.light.mutedForeground,
    marginBottom: spacing.lg,
  },
  description: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.mutedForeground,
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: spacing.lg,
  },
  actions: {
    gap: 12,
  },
  primaryButton: {
    backgroundColor: colors.light.primary,
    borderRadius: radius.xl,
    paddingVertical: 16,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
    shadowColor: colors.light.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  primaryButtonText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 16,
    color: colors.light.primaryForeground,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    borderRadius: radius.xl,
    paddingVertical: 16,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
  },
  secondaryButtonText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 16,
    color: colors.light.foreground,
  },
  buttonPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.98 }],
  },
  footer: {
    alignItems: "center",
    marginTop: 48,
    gap: 4,
  },
  footerText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.light.mutedForeground,
    letterSpacing: 0.5,
  },
  versionText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.light.mutedForeground,
    opacity: 0.6,
  },
});
