import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { GatewayUrlPanel } from "@/components/auth/GatewayUrlPanel";
import { SelfHostedSignInPanel } from "@/components/auth/SelfHostedSignInPanel";
import {
  getSelectedGatewayConnection,
  isHostedGatewayUrl,
  normalizeGatewayUrl,
  saveSelectedGatewayBasicAuth,
  saveSelectedGatewayUrl,
} from "@/lib/storage";
import { useGateway } from "./_layout";

/** Connects to a specific Matrix computer by URL -- the hosted cloud address
 * (handed back to the main sign-in screen) or a self-hosted computer's basic
 * auth credentials, connected directly from here. */
export default function SignInComputerScreen() {
  const router = useRouter();
  const { setGateway } = useGateway();

  const [gatewayUrl, setGatewayUrl] = useState("");
  const [basicUsername, setBasicUsername] = useState("matrix");
  const [basicPassword, setBasicPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

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

  const normalizedGatewayUrl = useMemo(() => {
    try {
      return normalizeGatewayUrl(gatewayUrl);
    } catch {
      return null;
    }
  }, [gatewayUrl]);
  const selfHostedSelected = Boolean(normalizedGatewayUrl && !isHostedGatewayUrl(normalizedGatewayUrl));

  const handleUrlChange = useCallback((value: string) => {
    setGatewayUrl(value);
    setError(null);
  }, []);

  const handleUrlBlur = useCallback(() => {
    try {
      setGatewayUrl(normalizeGatewayUrl(gatewayUrl));
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Enter a valid Matrix OS URL.");
    }
  }, [gatewayUrl]);

  const handleUseCloud = useCallback(async () => {
    try {
      await saveSelectedGatewayUrl(normalizeGatewayUrl(gatewayUrl));
    } catch {
      // The typed URL wasn't valid, so there's nothing to persist -- just
      // head back to the hosted sign-in screen either way.
    }
    router.back();
  }, [gatewayUrl, router]);

  const handleBasicPasswordChange = useCallback((value: string) => {
    setBasicPassword(value);
    setError(null);
  }, []);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    try {
      const gateway = await saveSelectedGatewayBasicAuth(gatewayUrl, basicUsername, basicPassword);
      setError(null);
      setGateway(gateway);
      router.replace("/(drawer)" as any);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Check the URL, username, and password.";
      setError(message);
      Alert.alert("Connection failed", message);
    } finally {
      setConnecting(false);
    }
  }, [basicPassword, basicUsername, gatewayUrl, router, setGateway]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={styles.content}>
          <GatewayUrlPanel
            url={gatewayUrl}
            onUrlChange={handleUrlChange}
            onUrlBlur={handleUrlBlur}
            onUseCloud={() => void handleUseCloud()}
            error={error}
            selfHostedSelected={selfHostedSelected}
            busy={connecting}
          />

          {selfHostedSelected ? (
            <SelfHostedSignInPanel
              username={basicUsername}
              onUsernameChange={setBasicUsername}
              password={basicPassword}
              onPasswordChange={handleBasicPasswordChange}
              connecting={connecting}
              busy={connecting}
              onConnect={() => void handleConnect()}
            />
          ) : null}
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
    padding: theme.v2.spacing.xl,
  },
  content: {
    width: "100%",
    maxWidth: 430,
    alignSelf: "center",
    gap: theme.v2.spacing.lg,
  },
}));
