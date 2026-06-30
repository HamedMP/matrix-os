import { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { makeRedirectUri } from "expo-auth-session";
import { useSSO, useAuth } from "@clerk/clerk-expo";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

WebBrowser.maybeCompleteAuthSession();

const clerkOAuthRedirectUrl =
  process.env.EXPO_PUBLIC_CLERK_OAUTH_REDIRECT_URL ??
  makeRedirectUri({ scheme: "matrixos", path: "sso-callback" });

export default function SignInScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const { startSSOFlow } = useSSO();

  const [loading, setLoading] = useState(false);
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (isSignedIn && !redirectedRef.current) {
      redirectedRef.current = true;
      router.replace("/(tabs)/apps" as any);
    }
  }, [isSignedIn, router]);

  const handleGoogleSignIn = useCallback(async () => {
    setLoading(true);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: "oauth_google",
        redirectUrl: clerkOAuthRedirectUrl,
      });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        redirectedRef.current = true;
        router.replace("/(tabs)/apps" as any);
      }
    } catch (err: unknown) {
      console.warn("[mobile] Google sign-in failed:", err);
      Alert.alert("Sign in failed", "Check the mobile OAuth redirect URL and try again.");
    } finally {
      setLoading(false);
    }
  }, [startSSOFlow, router]);

  if (isSignedIn) {
    return null;
  }

  return (
    <View style={styles.container}>
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
          <Text style={styles.title}>Enter your AI operating system</Text>
          <Text style={styles.subtitle}>
            Sign in to sync your shell, apps, channels, and agent state.
          </Text>
        </View>

        <Pressable
          onPress={handleGoogleSignIn}
          disabled={loading}
          style={({ pressed }) => [
            styles.googleButton,
            pressed && styles.buttonPressed,
          ]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={theme.colors.foreground} />
          ) : (
            <>
              <Ionicons name="logo-google" size={20} color={theme.colors.foreground} />
              <Text style={styles.googleButtonText}>Continue with Google</Text>
            </>
          )}
        </Pressable>

        <Text style={styles.termsText}>
          By continuing, you agree to our Terms of Service and Privacy Policy
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: theme.spacing.xl,
    justifyContent: "center",
  },
  header: {
    marginBottom: 40,
    alignItems: "center",
  },
  logoContainer: {
    width: 104,
    height: 104,
    borderRadius: 28,
    borderCurve: "continuous" as const,
    backgroundColor: theme.colors.card,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    boxShadow: "0 12px 28px rgba(50, 61, 46, 0.10)",
    marginBottom: theme.spacing.lg,
  },
  logo: {
    width: 76,
    height: 76,
  },
  wordmark: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12,
    color: theme.colors.forest,
    letterSpacing: 2.4,
    marginBottom: theme.spacing.lg,
  },
  title: {
    fontFamily: theme.fonts.sansBold,
    fontSize: 30,
    color: theme.colors.foreground,
    marginBottom: 8,
    textAlign: "center",
  },
  subtitle: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 15,
    color: theme.colors.mutedForeground,
    lineHeight: 22,
    textAlign: "center",
  },
  googleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 16,
    paddingHorizontal: 24,
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
  },
  googleButtonText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 16,
    color: theme.colors.foreground,
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
    marginTop: 24,
    lineHeight: 18,
    paddingHorizontal: theme.spacing.lg,
  },
}));
