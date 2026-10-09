import "@/lib/hermes-polyfills";
import { View, Text, Linking, Pressable } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { getClerkInstance, useAuth } from "@clerk/clerk-expo";
import { useEffect, useState } from "react";
import { HOSTED_GATEWAY_URL, getMobileJourneyGatewayUrl, getSelectedGatewayConnection, isHostedGatewayUrl } from "@/lib/storage";
import { JourneyGate } from "@/components/JourneyGate";
import { SignInScreen } from "@/components/auth/SignInScreen";
import { fetchMobileJourney, isConnectablePhase, type JourneyFetchResult } from "@/lib/journey";
import { forgetJourneyConnectable, rememberJourneyConnectable, wasJourneyConnectable } from "@/lib/journey-cache";
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
  const { getToken, signOut, userId } = useAuth();
  const [result, setResult] = useState<JourneyFetchResult | null>(null);
  const [working, setWorking] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      // True once this launch has opened the shell on a remembered answer; the
      // request below then only confirms it instead of holding the app back.
      let enteredFromMemory = false;
      try {
        const [gateway, remembered] = await Promise.all([
          getSelectedGatewayConnection(),
          userId ? wasJourneyConnectable(userId) : false,
        ]);
        if (!isHostedGatewayUrl(gateway.url)) {
          router.replace("/(drawer)" as any);
          return;
        }
        if (remembered && active) {
          enteredFromMemory = true;
          router.replace("/(drawer)" as any);
        }
        const token = await getToken();
        const next = await fetchMobileJourney(getMobileJourneyGatewayUrl(gateway.url), token);
        // With a remembered answer the shell has been open while this was in
        // flight, so by now another account may be signed in.
        const stillSignedIn = () => !enteredFromMemory || getClerkInstance().user?.id === userId;
        if (next.status === "ok" && isConnectablePhase(next.journey.phase)) {
          if (userId && stillSignedIn()) void rememberJourneyConnectable(userId);
          if (active && !enteredFromMemory) router.replace("/(drawer)" as any);
          return;
        }
        if (enteredFromMemory) {
          // Only a definite answer brings the user back to this gate. A check
          // that could not be made leaves them in the shell, which reports its
          // own connection errors.
          if (next.status === "unreachable") return;
          // The answer is about this user's account, so their remembered
          // answer goes whoever is signed in now.
          await forgetJourneyConnectable(userId);
          const selected = await getSelectedGatewayConnection();
          // Nothing is awaited between this check and the redirect: the
          // session on screen is not sent to the gate by an answer about a
          // different account or computer.
          if (selected.url !== gateway.url || !stillSignedIn()) return;
          router.replace("/" as any);
          return;
        }
        if (!active) return;
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
        if (active && !enteredFromMemory) setResult({ status: "unreachable" });
      }
    })();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [getToken, router, nonce, userId]);

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

  // An account can exist without ever getting past this gate (no plan, a failed
  // build), and deletion has to be reachable from inside the app for every
  // account (App Store Guideline 5.1.1(v)). The account API needs no computer.
  const canDeleteAccount = result?.status === "ok" && result.journey.phase !== "account_required";

  return (
    <View style={styles.gate}>
      <JourneyGate
        result={result}
        working={working}
        onRetry={handleRetry}
        onRefresh={reload}
        onSignOut={handleSignOut}
        onOpenUrl={(url) => { void Linking.openURL(url); }}
      />
      {canDeleteAccount ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete account"
          onPress={() => router.push("/settings-detail/delete-account" as any)}
          style={({ pressed }) => [styles.deleteAccount, pressed && styles.deleteAccountPressed]}
        >
          <Text style={styles.deleteAccountLabel}>Delete account</Text>
        </Pressable>
      ) : null}
    </View>
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
  // Same ground as JourneyGate, so the footer reads as part of the gate.
  gate: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  // In flow below the gate rather than overlaid, so it cannot cover the gate's
  // buttons on a short screen. The bottom padding clears the home indicator.
  deleteAccount: {
    alignSelf: "center",
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.lg,
    marginBottom: 40,
  },
  deleteAccountPressed: {
    opacity: 0.6,
  },
  deleteAccountLabel: {
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    color: theme.colors.forest,
    opacity: 0.8,
    textDecorationLine: "underline",
  },
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
