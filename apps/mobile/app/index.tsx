import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useAuth } from "@clerk/clerk-expo";
import { useEffect, useRef } from "react";
import { colors, fonts, spacing, radius } from "@/lib/theme";

export default function Index() {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (isSignedIn && !redirectedRef.current) {
      redirectedRef.current = true;
      router.replace("/(tabs)/apps" as any);
    }
  }, [isSignedIn, router]);

  if (isSignedIn) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.heroSection}>
          <View style={styles.iconContainer}>
            <Image
              source={require("../assets/logo.png")}
              style={styles.logo}
              contentFit="contain"
              accessibilityLabel="Matrix OS"
            />
          </View>
          <Text style={styles.wordmark}>MATRIX OS</Text>
          <Text style={styles.title}>Your AI operating system</Text>
          <Text style={styles.description}>
            Native access to your shell, apps, channels, and agent kernel.
          </Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={() => router.push("/sign-in")}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Ionicons name="person-circle-outline" size={20} color={colors.light.primaryForeground} />
            <Text style={styles.primaryButtonText}>Sign In</Text>
          </Pressable>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>matrix-os.com</Text>
          <Text style={styles.versionText}>v0.1.0 mobile</Text>
        </View>
      </View>
    </View>
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
    borderRadius: 28,
    borderCurve: "continuous" as const,
    backgroundColor: colors.light.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xl,
    boxShadow: "0 12px 28px rgba(50, 61, 46, 0.10)",
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  logo: {
    width: 70,
    height: 70,
  },
  wordmark: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 12,
    color: colors.light.forest,
    letterSpacing: 2.6,
    marginBottom: spacing.lg,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 34,
    color: colors.light.foreground,
    marginBottom: spacing.sm,
    textAlign: "center",
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
    borderCurve: "continuous" as const,
    paddingVertical: 16,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
    boxShadow: "0 4px 8px rgba(194, 112, 58, 0.2)",
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
    borderCurve: "continuous" as const,
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
