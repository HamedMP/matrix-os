import "@/lib/hermes-polyfills";
import { View, Text, Linking } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";
import { useEffect, useState } from "react";
import { HOSTED_GATEWAY_URL, getMobileJourneyGatewayUrl, getSelectedGatewayConnection, isHostedGatewayUrl } from "@/lib/storage";
import { JourneyGate } from "@/components/JourneyGate";
import { SignInScreen } from "@/components/auth/SignInScreen";
import { fetchMobileJourney, isConnectablePhase, type JourneyFetchResult } from "@/lib/journey";
import { clearAllScrollback } from "@/lib/terminal-scrollback";
import { resetAnalytics } from "@/lib/analytics";

// Re-poll cadence while the machine is building / payment is settling, so the
// user isn't stranded on a static spinner waiting for a phase transition.
const JOURNEY_POLL_INTERVAL_MS = 5_000;

// Signed-in users are routed through the journey gate: only a connectable phase
// (first_run/ready) enters the drawer shell; otherwise the user sees their
// onboarding phase (plan / settling / building / retry) instead of a broken shell.
function SignedInJourneyGate() {
  const router = useRouter();
  const { getToken, signOut } = useAuth();
  const [result, setResult] = useState<JourneyFetchResult | null>(null);
  const [working, setWorking] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const gateway = await getSelectedGatewayConnection();
        if (!isHostedGatewayUrl(gateway.url)) {
          router.replace("/(drawer)" as any);
          return;
        }
        const token = await getToken();
        const next = await fetchMobileJourney(getMobileJourneyGatewayUrl(gateway.url), token);
        if (!active) return;
        if (next.status === "ok" && isConnectablePhase(next.journey.phase)) {
          router.replace("/(drawer)" as any);
          return;
        }
        setResult(next);
        // Auto-poll transitional phases so the spinner actually progresses and
        // hands off to the shell once ready; terminal phases wait on the user.
        if (next.status === "ok" && (next.journey.phase === "provisioning" || next.journey.phase === "payment_settling")) {
          timer = setTimeout(() => { if (active) setNonce((n) => n + 1); }, JOURNEY_POLL_INTERVAL_MS);
        }
      } catch (err: unknown) {
        // getToken() (Clerk token refresh) can reject; don't strand the user on
        // a permanent spinner — surface a retryable unreachable state instead.
        console.warn("[mobile] journey load failed", err instanceof Error ? err.name : typeof err);
        if (active) setResult({ status: "unreachable" });
      }
    })();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [getToken, router, nonce]);

  function reload() {
    setResult(null);
    setNonce((n) => n + 1);
  }

  async function handleSignOut() {
    // Clearing the Clerk session flips isSignedIn → false, so Index re-renders
    // the landing screen where the user can sign in again.
    clearAllScrollback();
    resetAnalytics();
    try {
      await signOut();
    } catch (err: unknown) {
      console.warn("[mobile] sign-out failed", err instanceof Error ? err.name : typeof err);
    }
  }

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
      reload();
    }
  }

  return (
    <JourneyGate
      result={result}
      working={working}
      onRetry={handleRetry}
      onRefresh={reload}
      onSignOut={handleSignOut}
      onOpenUrl={(url) => { void Linking.openURL(url); }}
    />
  );
}

export default function Index() {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const [checkingSelfHosted, setCheckingSelfHosted] = useState(true);

  useEffect(() => {
    if (isSignedIn) {
      return;
    }
    let cancelled = false;
    getSelectedGatewayConnection()
      .then((gateway) => {
        if (cancelled) return;
        if (!isHostedGatewayUrl(gateway.url) && gateway.token) {
          router.replace("/(drawer)" as any);
          return;
        }
        setCheckingSelfHosted(false);
      })
      .catch(() => {
        if (!cancelled) setCheckingSelfHosted(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, router]);

  if (isSignedIn) {
    return <SignedInJourneyGate />;
  }

  if (checkingSelfHosted) {
    return (
      <View style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.wordmark}>MATRIX OS</Text>
        </View>
      </View>
    );
  }

  return <SignInScreen />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.v2.appColors.canvas,
  },
  content: {
    flex: 1,
    paddingHorizontal: theme.v2.spacing.xl,
    justifyContent: "center",
  },
  wordmark: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 12,
    color: theme.v2.appColors.muted,
    letterSpacing: 2.6,
    textAlign: "center",
  },
}));
