import "@/lib/hermes-polyfills";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
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
import { SelfHostedSignInPanel } from "@/components/auth/SelfHostedSignInPanel";
import { GatewayUrlPanel } from "@/components/auth/GatewayUrlPanel";
import {
  HOSTED_GATEWAY_URL,
  getSelectedGatewayConnection,
  isHostedGatewayUrl,
  normalizeGatewayUrl,
  saveSelectedGatewayBasicAuth,
  saveSelectedGatewayUrl,
} from "@/lib/storage";
import { useGateway } from "./_layout";

WebBrowser.maybeCompleteAuthSession();

const clerkOAuthRedirectUrl =
  process.env.EXPO_PUBLIC_CLERK_OAUTH_REDIRECT_URL ??
  makeRedirectUri({ scheme: "matrixos", path: "sso-callback" });

type OAuthStrategy = "oauth_google" | "oauth_github";
type AuthProvider = "google" | "github" | "basic";

export default function SignInScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const { startSSOFlow } = useSSO();
  const { setGateway } = useGateway();

  const [loadingProvider, setLoadingProvider] = useState<AuthProvider | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState(HOSTED_GATEWAY_URL);
  const [basicUsername, setBasicUsername] = useState("matrix");
  const [basicPassword, setBasicPassword] = useState("");
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const redirectedRef = useRef(false);
  const normalizedGatewayUrl = useMemo(() => {
    try {
      return normalizeGatewayUrl(gatewayUrl);
    } catch {
      return null;
    }
  }, [gatewayUrl]);
  const selfHostedSelected = Boolean(normalizedGatewayUrl && !isHostedGatewayUrl(normalizedGatewayUrl));

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
      router.replace("/(tabs)/apps" as any);
    }
  }, [isSignedIn, router]);

  const handleOAuthSignIn = useCallback(async (strategy: OAuthStrategy, provider: AuthProvider) => {
    setLoadingProvider(provider);
    try {
      const normalizedGatewayUrl = normalizeGatewayUrl(gatewayUrl);
      await saveSelectedGatewayUrl(normalizedGatewayUrl);
      setGatewayUrl(normalizedGatewayUrl);
      setGatewayError(null);
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy,
        redirectUrl: clerkOAuthRedirectUrl,
      });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        redirectedRef.current = true;
        router.replace("/(tabs)/apps" as any);
      }
    } catch (err: unknown) {
      console.warn(`[mobile] ${provider} sign-in failed:`, err);
      const message = describeSignInFailure(
        err,
        "Check the mobile OAuth redirect URL and try again.",
      );
      setGatewayError(message);
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

  const goToApps = useCallback(() => {
    setGatewayError(null);
    redirectedRef.current = true;
    router.replace("/(tabs)/apps" as any);
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
    setGatewayError(null);
  }, [gatewayUrl]);

  const emailSignIn = useEmailCodeSignIn({
    prepareGateway,
    onError: setGatewayError,
    onSuccess: goToApps,
  });

  const handleEmailChange = useCallback(
    (value: string) => {
      emailSignIn.setEmail(value);
      setGatewayError(null);
    },
    [emailSignIn],
  );

  const handleCodeChange = useCallback(
    (value: string) => {
      emailSignIn.setCode(value);
      setGatewayError(null);
    },
    [emailSignIn],
  );

  const handleGatewayUrlChange = useCallback((value: string) => {
    setGatewayUrl(value);
    setGatewayError(null);
  }, []);

  const handleGatewayUrlBlur = useCallback(() => {
    try {
      setGatewayUrl(normalizeGatewayUrl(gatewayUrl));
      setGatewayError(null);
    } catch (err: unknown) {
      setGatewayError(err instanceof Error ? err.message : "Enter a valid Matrix OS URL.");
    }
  }, [gatewayUrl]);

  const handleUseCloud = useCallback(() => {
    setGatewayUrl(HOSTED_GATEWAY_URL);
    setGatewayError(null);
  }, []);

  const handleBasicPasswordChange = useCallback((value: string) => {
    setBasicPassword(value);
    setGatewayError(null);
  }, []);

  const handleUseDifferentEmail = useCallback(() => {
    emailSignIn.reset();
    setGatewayError(null);
  }, [emailSignIn]);

  const handleBasicSignIn = useCallback(async () => {
    setLoadingProvider("basic");
    try {
      const gateway = await saveSelectedGatewayBasicAuth(gatewayUrl, basicUsername, basicPassword);
      setGatewayUrl(gateway.url);
      setGatewayError(null);
      setGateway(gateway);
      router.replace("/(tabs)/apps" as any);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Check the URL, username, and password.";
      setGatewayError(message);
      Alert.alert("Connection failed", message);
    } finally {
      setLoadingProvider(null);
    }
  }, [basicPassword, basicUsername, gatewayUrl, router, setGateway]);

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
            <View style={styles.logoContainer}>
              <Image
                source={require("../assets/icon.png")}
                style={styles.logo}
                contentFit="contain"
                accessibilityLabel="Matrix OS"
              />
            </View>
            <Text style={styles.wordmark}>MATRIX OS</Text>
            <Text style={styles.title}>Sign in to Matrix OS</Text>
            <Text style={styles.subtitle}>
              Choose your Matrix computer, then continue with your account.
            </Text>
          </View>

          <GatewayUrlPanel
            url={gatewayUrl}
            onUrlChange={handleGatewayUrlChange}
            onUrlBlur={handleGatewayUrlBlur}
            onUseCloud={handleUseCloud}
            error={gatewayError}
            selfHostedSelected={selfHostedSelected}
            busy={loadingProvider !== null}
          />

          {selfHostedSelected ? (
            <SelfHostedSignInPanel
              username={basicUsername}
              onUsernameChange={setBasicUsername}
              password={basicPassword}
              onPasswordChange={handleBasicPasswordChange}
              connecting={loadingProvider === "basic"}
              busy={loadingProvider !== null}
              onConnect={handleBasicSignIn}
            />
          ) : (
            <HostedSignInPanel
              loadingProvider={loadingProvider}
              sendingCode={emailSignIn.sending}
              verifyingCode={emailSignIn.verifying}
              onGoogle={handleGoogleSignIn}
              onGithub={handleGithubSignIn}
              email={emailSignIn.email}
              onEmailChange={handleEmailChange}
              code={emailSignIn.code}
              onCodeChange={handleCodeChange}
              codeSentTo={emailSignIn.codeSentTo}
              onSendCode={emailSignIn.sendCode}
              onVerify={emailSignIn.verifyCode}
              onUseDifferentEmail={handleUseDifferentEmail}
            />
          )}

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
    backgroundColor: theme.colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.xl,
    justifyContent: "center",
  },
  content: {
    width: "100%",
    maxWidth: 430,
    alignSelf: "center",
  },
  header: {
    marginBottom: 24,
    alignItems: "center",
  },
  logoContainer: {
    width: 82,
    height: 82,
    borderRadius: 23,
    borderCurve: "continuous" as const,
    backgroundColor: theme.colors.card,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.glass.border,
    boxShadow: theme.shadows.raised,
    marginBottom: theme.spacing.md,
  },
  logo: {
    width: 60,
    height: 60,
  },
  wordmark: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.forest,
    letterSpacing: 2.4,
    marginBottom: theme.spacing.md,
  },
  title: {
    fontFamily: theme.fonts.display,
    fontSize: 29,
    color: theme.colors.foreground,
    marginBottom: 7,
    textAlign: "center",
  },
  subtitle: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 15,
    color: theme.colors.mutedForeground,
    lineHeight: 21,
    textAlign: "center",
    paddingHorizontal: theme.spacing.sm,
  },
  termsText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
    textAlign: "center",
    marginTop: 18,
    lineHeight: 18,
    paddingHorizontal: theme.spacing.lg,
  },
}));
