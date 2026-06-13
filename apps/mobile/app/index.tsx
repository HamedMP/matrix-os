import { View, Text, Pressable, StyleSheet, Linking } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useAuth } from "@clerk/clerk-expo";
import { useEffect, useState } from "react";
import { colors, fonts, spacing, radius } from "@/lib/theme";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { JourneyGate } from "@/components/JourneyGate";
import { fetchMobileJourney, isConnectablePhase, type JourneyFetchResult } from "@/lib/journey";

// Signed-in users are routed through the journey gate: only a connectable phase
// (first_run/ready) enters the shell tabs; otherwise the user sees their
// onboarding phase (plan / settling / building / retry) instead of a broken shell.
function SignedInJourneyGate() {
  const router = useRouter();
  const { getToken } = useAuth();
  const [result, setResult] = useState<JourneyFetchResult | null>(null);
  const [working, setWorking] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      const token = await getToken();
      const next = await fetchMobileJourney(HOSTED_GATEWAY_URL, token);
      if (!active) return;
      if (next.status === "ok" && isConnectablePhase(next.journey.phase)) {
        router.replace("/(tabs)/apps" as any);
        return;
      }
      setResult(next);
    })();
    return () => {
      active = false;
    };
  }, [getToken, router, nonce]);

  async function handleRetry() {
    setWorking(true);
    try {
      const token = await getToken();
      if (token) {
        await fetch(`${HOSTED_GATEWAY_URL.replace(/\/+$/, "")}/api/journey/retry-provision`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch (err: unknown) {
      // Best-effort trigger; the refetch below reflects the real state.
      console.warn("[mobile] retry-provision failed", err instanceof Error ? err.name : typeof err);
    } finally {
      setWorking(false);
      setResult(null);
      setNonce((n) => n + 1);
    }
  }

  return (
    <JourneyGate
      result={result}
      working={working}
      onRetry={handleRetry}
      onOpenUrl={(url) => { void Linking.openURL(url); }}
    />
  );
}

export default function Index() {
  const { isSignedIn } = useAuth();
  const router = useRouter();

  if (isSignedIn) {
    return <SignedInJourneyGate />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.heroSection}>
          <View style={styles.iconContainer}>
            <Image
              source={require("../assets/icon.png")}
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
