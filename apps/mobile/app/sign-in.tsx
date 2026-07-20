import "@/lib/hermes-polyfills";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Alert,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { makeRedirectUri } from "expo-auth-session";
import { useSSO, useAuth, useSignIn } from "@clerk/clerk-expo";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import {
  EmailCodeSignInError,
  isLikelyEmail,
  isValidVerificationCode,
  normalizeSignInIdentifier,
  requestEmailCode,
  submitEmailCode,
  type SignInAttemptLike,
} from "@/lib/clerk-sign-in";
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
type AuthProvider = "google" | "github" | "basic" | "email" | "code";

export default function SignInScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const { startSSOFlow } = useSSO();
  const { signIn, setActive: setActiveSession, isLoaded: signInLoaded } = useSignIn();
  const { setGateway } = useGateway();

  const [loadingProvider, setLoadingProvider] = useState<AuthProvider | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState(HOSTED_GATEWAY_URL);
  const [basicUsername, setBasicUsername] = useState("matrix");
  const [basicPassword, setBasicPassword] = useState("");
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const redirectedRef = useRef(false);
  // The pending Clerk attempt is only read inside submit handlers, so a ref keeps
  // it out of the render path.
  const emailAttemptRef = useRef<SignInAttemptLike | null>(null);
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
      const message = err instanceof Error ? err.message : "Check the mobile OAuth redirect URL and try again.";
      setGatewayError(message);
      Alert.alert("Sign in failed", message);
    } finally {
      setLoadingProvider(null);
    }
  }, [gatewayUrl, startSSOFlow, router]);

  const handleSendEmailCode = useCallback(async () => {
    if (!signInLoaded || !signIn) return;
    setLoadingProvider("email");
    try {
      const normalizedGatewayUrl = normalizeGatewayUrl(gatewayUrl);
      await saveSelectedGatewayUrl(normalizedGatewayUrl);
      setGatewayUrl(normalizedGatewayUrl);
      setGatewayError(null);
      const { attempt, maskedIdentifier } = await requestEmailCode(
        signIn as never,
        email,
      );
      emailAttemptRef.current = attempt;
      setCodeSentTo(maskedIdentifier);
      setCode("");
    } catch (err: unknown) {
      const message =
        err instanceof EmailCodeSignInError
          ? err.message
          : err instanceof Error
            ? err.message
            : "We could not send the code. Try again in a moment.";
      console.warn("[mobile] email code request failed:", err);
      setGatewayError(message);
      Alert.alert("Sign in failed", message);
    } finally {
      setLoadingProvider(null);
    }
  }, [email, gatewayUrl, signIn, signInLoaded]);

  const handleVerifyEmailCode = useCallback(async () => {
    const attempt = emailAttemptRef.current;
    if (!attempt || !setActiveSession) return;
    setLoadingProvider("code");
    try {
      const createdSessionId = await submitEmailCode(attempt, code);
      await setActiveSession({ session: createdSessionId });
      emailAttemptRef.current = null;
      setGatewayError(null);
      redirectedRef.current = true;
      router.replace("/(tabs)/apps" as any);
    } catch (err: unknown) {
      const message =
        err instanceof EmailCodeSignInError
          ? err.message
          : err instanceof Error
            ? err.message
            : "That code did not work. Request a new one and try again.";
      console.warn("[mobile] email code verification failed:", err);
      setGatewayError(message);
      Alert.alert("Sign in failed", message);
    } finally {
      setLoadingProvider(null);
    }
  }, [code, router, setActiveSession]);

  const handleUseDifferentEmail = useCallback(() => {
    emailAttemptRef.current = null;
    setCodeSentTo(null);
    setCode("");
    setGatewayError(null);
  }, []);

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
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
      style={styles.container}
    >
      <ScrollView
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

          <View style={styles.gatewayPanel}>
            <Text style={styles.gatewayLabel}>Computer URL</Text>
            <View style={[styles.gatewayInputRow, gatewayError ? styles.gatewayInputRowError : null]}>
              <Ionicons name="server-outline" size={17} color={theme.colors.inkMuted} />
              <TextInput
                value={gatewayUrl}
                onChangeText={(value) => {
                  setGatewayUrl(value);
                  setGatewayError(null);
                }}
                placeholder={HOSTED_GATEWAY_URL}
                placeholderTextColor={theme.colors.inkDim}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="url"
                blurOnSubmit
                clearButtonMode="while-editing"
                keyboardType="url"
                textContentType="URL"
                returnKeyType="done"
                style={styles.gatewayInput}
                onBlur={() => {
                  try {
                    setGatewayUrl(normalizeGatewayUrl(gatewayUrl));
                    setGatewayError(null);
                  } catch (err: unknown) {
                    setGatewayError(err instanceof Error ? err.message : "Enter a valid Matrix OS URL.");
                  }
                }}
              />
            </View>
            {gatewayError ? (
              <Text selectable style={styles.gatewayError}>{gatewayError}</Text>
            ) : (
              <Text style={styles.gatewayHint}>
                {selfHostedSelected
                  ? "Use the installer credentials shown after setup."
                  : "Use the cloud URL, https:// domain, or http:// VPS IP."}
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Use Matrix OS Cloud"
              disabled={loadingProvider !== null}
              onPress={() => {
                setGatewayUrl(HOSTED_GATEWAY_URL);
                setGatewayError(null);
              }}
              style={({ pressed }) => [styles.cloudLink, pressed && styles.buttonPressed]}
            >
              <Text style={styles.cloudLinkText}>Use Matrix OS Cloud</Text>
            </Pressable>
          </View>

          {selfHostedSelected ? (
            <View style={styles.authPanel}>
              <Text style={styles.authPanelTitle}>Basic Auth</Text>
              <View style={styles.basicFields}>
                <View style={styles.basicInputRow}>
                  <Ionicons name="person-outline" size={17} color={theme.colors.inkMuted} />
                  <TextInput
                    value={basicUsername}
                    onChangeText={setBasicUsername}
                    placeholder="matrix"
                    placeholderTextColor={theme.colors.inkDim}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                    style={styles.gatewayInput}
                  />
                </View>
                <View style={styles.basicInputRow}>
                  <Ionicons name="key-outline" size={17} color={theme.colors.inkMuted} />
                  <TextInput
                    value={basicPassword}
                    onChangeText={(value) => {
                      setBasicPassword(value);
                      setGatewayError(null);
                    }}
                    placeholder="Installer password"
                    placeholderTextColor={theme.colors.inkDim}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                    textContentType="password"
                    returnKeyType="go"
                    onSubmitEditing={handleBasicSignIn}
                    style={styles.gatewayInput}
                  />
                </View>
              </View>
              <Pressable
                onPress={handleBasicSignIn}
                disabled={loadingProvider !== null}
                style={({ pressed }) => [
                  styles.authButtonPrimary,
                  pressed && styles.buttonPressed,
                  loadingProvider !== null && styles.authButtonDisabled,
                ]}
              >
                {loadingProvider === "basic" ? (
                  <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
                ) : (
                  <>
                    <Ionicons name="log-in-outline" size={19} color={theme.colors.primaryForeground} />
                    <Text style={styles.authButtonPrimaryText}>Connect to self-hosted Matrix</Text>
                  </>
                )}
              </Pressable>
            </View>
          ) : (
            <View style={styles.authPanel}>
              <Text style={styles.authPanelTitle}>Sign in to this computer</Text>
              <Pressable
                onPress={() => handleOAuthSignIn("oauth_google", "google")}
                disabled={loadingProvider !== null}
                style={({ pressed }) => [
                  styles.authButtonPrimary,
                  pressed && styles.buttonPressed,
                  loadingProvider !== null && styles.authButtonDisabled,
                ]}
              >
                {loadingProvider === "google" ? (
                  <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
                ) : (
                  <>
                    <Ionicons name="logo-google" size={19} color={theme.colors.primaryForeground} />
                    <Text style={styles.authButtonPrimaryText}>Continue with Google</Text>
                  </>
                )}
              </Pressable>
              <Pressable
                onPress={() => handleOAuthSignIn("oauth_github", "github")}
                disabled={loadingProvider !== null}
                style={({ pressed }) => [
                  styles.authButtonSecondary,
                  pressed && styles.buttonPressed,
                  loadingProvider !== null && styles.authButtonDisabled,
                ]}
              >
                {loadingProvider === "github" ? (
                  <ActivityIndicator size="small" color={theme.colors.foreground} />
                ) : (
                  <>
                    <Ionicons name="logo-github" size={20} color={theme.colors.foreground} />
                    <Text style={styles.authButtonSecondaryText}>Continue with GitHub</Text>
                  </>
                )}
              </Pressable>

              <View style={styles.divider}>
                <View style={styles.dividerRule} />
                <Text style={styles.dividerText}>or</Text>
                <View style={styles.dividerRule} />
              </View>

              {codeSentTo === null ? (
                <>
                  <View style={styles.basicInputRow}>
                    <Ionicons name="mail-outline" size={17} color={theme.colors.inkMuted} />
                    <TextInput
                      value={email}
                      onChangeText={(value) => {
                        setEmail(value);
                        setGatewayError(null);
                      }}
                      placeholder="you@example.com"
                      placeholderTextColor={theme.colors.inkDim}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="email"
                      keyboardType="email-address"
                      textContentType="emailAddress"
                      returnKeyType="go"
                      onSubmitEditing={handleSendEmailCode}
                      onBlur={() => setEmail(normalizeSignInIdentifier(email))}
                      style={styles.gatewayInput}
                      accessibilityLabel="Email address"
                    />
                  </View>
                  <Pressable
                    onPress={handleSendEmailCode}
                    disabled={loadingProvider !== null || !isLikelyEmail(email)}
                    style={({ pressed }) => [
                      styles.authButtonSecondary,
                      pressed && styles.buttonPressed,
                      (loadingProvider !== null || !isLikelyEmail(email)) &&
                        styles.authButtonDisabled,
                    ]}
                  >
                    {loadingProvider === "email" ? (
                      <ActivityIndicator size="small" color={theme.colors.foreground} />
                    ) : (
                      <>
                        <Ionicons name="mail-outline" size={19} color={theme.colors.foreground} />
                        <Text style={styles.authButtonSecondaryText}>Email me a code</Text>
                      </>
                    )}
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.codeHint}>
                    We sent a 6-digit code to {codeSentTo}.
                  </Text>
                  <View style={styles.basicInputRow}>
                    <Ionicons name="keypad-outline" size={17} color={theme.colors.inkMuted} />
                    <TextInput
                      value={code}
                      onChangeText={(value) => {
                        setCode(value);
                        setGatewayError(null);
                      }}
                      placeholder="123456"
                      placeholderTextColor={theme.colors.inkDim}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="one-time-code"
                      keyboardType="number-pad"
                      textContentType="oneTimeCode"
                      maxLength={7}
                      returnKeyType="go"
                      onSubmitEditing={handleVerifyEmailCode}
                      style={styles.gatewayInput}
                      accessibilityLabel="Verification code"
                    />
                  </View>
                  <Pressable
                    onPress={handleVerifyEmailCode}
                    disabled={loadingProvider !== null || !isValidVerificationCode(code)}
                    style={({ pressed }) => [
                      styles.authButtonPrimary,
                      pressed && styles.buttonPressed,
                      (loadingProvider !== null || !isValidVerificationCode(code)) &&
                        styles.authButtonDisabled,
                    ]}
                  >
                    {loadingProvider === "code" ? (
                      <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
                    ) : (
                      <Text style={styles.authButtonPrimaryText}>Verify and sign in</Text>
                    )}
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={handleUseDifferentEmail}
                    disabled={loadingProvider !== null}
                    style={({ pressed }) => [styles.cloudLink, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.cloudLinkText}>Use a different email</Text>
                  </Pressable>
                </>
              )}
            </View>
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
  authPanel: {
    marginTop: 16,
    gap: 10,
  },
  authPanelTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  authButtonPrimary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    paddingVertical: 16,
    paddingHorizontal: 24,
    boxShadow: "0 10px 22px rgba(194, 112, 58, 0.18)",
  },
  authButtonSecondary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 15,
    paddingHorizontal: 24,
  },
  authButtonDisabled: {
    opacity: 0.72,
  },
  authButtonPrimaryText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 16,
    color: theme.colors.primaryForeground,
  },
  authButtonSecondaryText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 16,
    color: theme.colors.foreground,
  },
  basicFields: {
    gap: 8,
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 2,
  },
  dividerRule: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  dividerText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
    color: theme.colors.mutedForeground,
  },
  codeHint: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.mutedForeground,
  },
  basicInputRow: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.field,
  },
  gatewayPanel: {
    borderRadius: theme.radius.xl,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: 14,
    gap: 8,
  },
  gatewayLabel: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  gatewayInputRow: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.field,
  },
  gatewayInputRowError: {
    borderColor: theme.colors.destructive,
  },
  gatewayInput: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.foreground,
    paddingVertical: 10,
  },
  gatewayHint: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.mutedForeground,
  },
  gatewayError: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.destructive,
  },
  cloudLink: {
    alignSelf: "flex-start",
    paddingVertical: 5,
    paddingHorizontal: 2,
  },
  cloudLinkText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.accentInk,
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
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
