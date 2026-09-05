import { useState, useCallback, useEffect, useRef } from "react";
import { View, Text, Alert, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { makeRedirectUri } from "expo-auth-session";
import { useSSO, useAuth } from "@clerk/clerk-expo";
import * as WebBrowser from "expo-web-browser";
import { Image } from "expo-image";
import { describeSignInFailure } from "@/lib/clerk-sign-in";
import { SignInStepError, useEmailCodeSignIn } from "@/lib/use-email-code-sign-in";
import { HostedSignInPanel } from "@/components/auth/HostedSignInPanel";
import {
  HOSTED_GATEWAY_URL,
  getSelectedGatewayConnection,
  normalizeGatewayUrl,
  saveSelectedGatewayUrl,
} from "@/lib/storage";

const rabbitArtwork = require("../../assets/app.icon/Assets/rabbit.svg");

WebBrowser.maybeCompleteAuthSession();

const clerkOAuthRedirectUrl =
  process.env.EXPO_PUBLIC_CLERK_OAUTH_REDIRECT_URL ??
  makeRedirectUri({ scheme: "matrixos", path: "sso-callback" });

type OAuthStrategy = "oauth_google" | "oauth_github";
type AuthProvider = "google" | "github";

/** The MatrixOS sign-in surface -- rendered as the logged-out index route and
 * reused as-is at the standalone /sign-in route (e.g. post-sign-out redirects). */
export function SignInScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const { startSSOFlow } = useSSO();

  const [loadingProvider, setLoadingProvider] = useState<AuthProvider | null>(null);
  // Not user-editable on this screen -- always the hosted cloud computer.
  // Restored from storage below only so Clerk calls persist whichever
  // gateway a "Sign in with computer URL" connection last selected.
  const [gatewayUrl, setGatewayUrl] = useState(HOSTED_GATEWAY_URL);
  const [signInError, setSignInError] = useState<string | null>(null);
  const redirectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getSelectedGatewayConnection()
      .then((gateway) => {
        if (!cancelled) setGatewayUrl(gateway.url);
      })
      .catch((err: unknown) => {
        console.warn("[mobile] failed to load selected gateway", err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isSignedIn && !redirectedRef.current) {
      redirectedRef.current = true;
      router.replace("/(drawer)" as any);
    }
  }, [isSignedIn, router]);

  const handleOAuthSignIn = useCallback(async (strategy: OAuthStrategy, provider: AuthProvider) => {
    setLoadingProvider(provider);
    try {
      const normalizedGatewayUrl = normalizeGatewayUrl(gatewayUrl);
      await saveSelectedGatewayUrl(normalizedGatewayUrl);
      setGatewayUrl(normalizedGatewayUrl);
      setSignInError(null);
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy,
        redirectUrl: clerkOAuthRedirectUrl,
      });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        redirectedRef.current = true;
        router.replace("/(drawer)" as any);
      }
    } catch (err: unknown) {
      console.warn(`[mobile] ${provider} sign-in failed:`, err);
      const message = describeSignInFailure(
        err,
        "Check the mobile OAuth redirect URL and try again.",
      );
      setSignInError(message);
      Alert.alert("Sign in failed", message);
    } finally {
      setLoadingProvider(null);
    }
  }, [gatewayUrl, startSSOFlow, router]);

  const handleGoogleSignIn = useCallback(
    () => handleOAuthSignIn("oauth_google", "google"),
    [handleOAuthSignIn],
  );

  const handleGithubSignIn = useCallback(
    () => handleOAuthSignIn("oauth_github", "github"),
    [handleOAuthSignIn],
  );

  const handleComputerSignIn = useCallback(() => {
    router.push("/sign-in-computer" as any);
  }, [router]);

  const goToApps = useCallback(() => {
    setSignInError(null);
    redirectedRef.current = true;
    router.replace("/(drawer)" as any);
  }, [router]);

  // Persist the chosen computer before Clerk is involved, so a bad URL reports
  // its own message instead of being normalised as a sign-in failure.
  const prepareGateway = useCallback(async () => {
    let targetGatewayUrl: string;
    try {
      targetGatewayUrl = normalizeGatewayUrl(gatewayUrl);
    } catch (err: unknown) {
      throw new SignInStepError(
        err instanceof Error ? err.message : "Enter a valid Matrix OS URL.",
      );
    }
    await saveSelectedGatewayUrl(targetGatewayUrl);
    setGatewayUrl(targetGatewayUrl);
    setSignInError(null);
  }, [gatewayUrl]);

  const emailSignIn = useEmailCodeSignIn({
    prepareGateway,
    onError: setSignInError,
    onSuccess: goToApps,
  });

  const handleEmailChange = useCallback(
    (value: string) => {
      emailSignIn.setEmail(value);
      setSignInError(null);
    },
    [emailSignIn],
  );

  const handlePasswordChange = useCallback(
    (value: string) => {
      emailSignIn.setPassword(value);
      setSignInError(null);
    },
    [emailSignIn],
  );

  const handleCodeChange = useCallback(
    (value: string) => {
      emailSignIn.setCode(value);
      setSignInError(null);
    },
    [emailSignIn],
  );

  const handleUseDifferentEmail = useCallback(() => {
    emailSignIn.reset();
    setSignInError(null);
  }, [emailSignIn]);

  if (isSignedIn) {
    return null;
  }

  return (
    // The content is vertically centred, so on iOS a `padding` behavior just
    // shrinks the viewport around the centred block and leaves a focused field
    // under the keyboard. `automaticallyAdjustKeyboardInsets` scrolls the focused
    // field into view instead; Android has no equivalent and keeps `height`.
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? undefined : "height"}
      keyboardVerticalOffset={0}
      style={styles.container}
    >
      <ScrollView
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: Math.max(insets.top + 18, 34),
            paddingBottom: Math.max(insets.bottom + 28, 40),
          },
        ]}
      >
        <View style={styles.content}>
          <View style={styles.header}>
            <Image
              source={rabbitArtwork}
              style={styles.logo}
              contentFit="contain"
              accessibilityLabel="Matrix OS"
            />
            <Text style={styles.title}>Sign in to MatrixOS</Text>
          </View>

          {signInError ? <Text style={styles.errorText}>{signInError}</Text> : null}

          <HostedSignInPanel
            loadingProvider={loadingProvider}
            signingInWithPassword={emailSignIn.signingIn}
            sendingCode={emailSignIn.sending}
            verifyingCode={emailSignIn.verifying}
            onGoogle={handleGoogleSignIn}
            onGithub={handleGithubSignIn}
            onComputer={handleComputerSignIn}
            email={emailSignIn.email}
            onEmailChange={handleEmailChange}
            password={emailSignIn.password}
            onPasswordChange={handlePasswordChange}
            passwordUnavailable={emailSignIn.passwordUnavailable}
            code={emailSignIn.code}
            onCodeChange={handleCodeChange}
            codeSentTo={emailSignIn.codeSentTo}
            onSignIn={emailSignIn.signInWithPassword}
            onSendCode={emailSignIn.sendCode}
            onVerify={emailSignIn.verifyCode}
            onUseDifferentEmail={handleUseDifferentEmail}
          />

          <Text style={styles.termsText}>
            By continuing, you agree to our Terms of Service and Privacy Policy
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.v2.appColors.canvas,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: theme.v2.spacing.xl,
    justifyContent: "center",
  },
  content: {
    width: "100%",
    maxWidth: 430,
    alignSelf: "center",
  },
  header: {
    marginBottom: 28,
    alignItems: "center",
  },
  logo: {
    width: 72,
    height: 72,
    marginBottom: theme.v2.spacing.lg,
  },
  title: {
    fontFamily: theme.v2.fonts.display,
    fontSize: 26,
    color: theme.v2.appColors.ink,
    textAlign: "center",
  },
  errorText: {
    fontFamily: theme.v2.fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: theme.v2.colors.danger,
    textAlign: "center",
    marginBottom: 12,
  },
  termsText: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 12,
    color: theme.v2.appColors.muted,
    textAlign: "center",
    marginTop: 22,
    lineHeight: 18,
    paddingHorizontal: theme.v2.spacing.lg,
  },
}));
