import "@/lib/hermes-polyfills";
import "@/lib/unistyles";
import { use, useEffect, useMemo, useState, createContext, useCallback, useRef } from "react";
import { Stack, useRouter, usePathname } from "expo-router";
import { PostHogProvider } from "posthog-react-native";
import { StatusBar } from "expo-status-bar";
import { Text, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import * as SplashScreen from "expo-splash-screen";
import * as SecureStore from "expo-secure-store";
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_700Bold,
} from "@expo-google-fonts/jetbrains-mono";
import {
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
} from "@expo-google-fonts/bricolage-grotesque";
import {
  Geist_400Regular,
  Geist_500Medium,
  Geist_600SemiBold,
  Geist_700Bold,
  Geist_800ExtraBold,
} from "@expo-google-fonts/geist";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ClerkProvider, useAuth } from "@clerk/clerk-expo";
import { QueryClientProvider } from "@tanstack/react-query";
import { GatewayClient } from "@/lib/gateway-client";
import { CanonicalChatSessionProvider } from "@/lib/canonical-chat-session-context";
import { mobileQueryClient } from "@/lib/query-client";
import { getSelectedGatewayConnection, isHostedGatewayUrl, type GatewayConnection } from "@/lib/storage";
import { authenticateBiometric } from "@/lib/auth";
import { addNotificationResponseListener, handleNotificationTap } from "@/lib/push";
import { StartupScreen } from "@/components/StartupScreen";
import { startMobileThemeController } from "@/lib/theme-preference";
import { OtaUpdatePrompt } from "@/components/OtaUpdatePrompt";
import {
  captureScreen,
  getAnalyticsClient,
  identifyUser,
  sanitizeScreenName,
} from "@/lib/analytics";

let nativeSplashRegistered = false;
const nativeSplashRegistration = SplashScreen.preventAutoHideAsync()
  .then(() => {
    nativeSplashRegistered = true;
    return true;
  })
  .catch((err: unknown) => {
    console.warn("[mobile] Native splash screen was not registered:", err);
    return false;
  });

const clerkPublishableKey =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const tokenCache = {
  async getToken(key: string) {
    return SecureStore.getItemAsync(key);
  },
  async saveToken(key: string, value: string) {
    return SecureStore.setItemAsync(key, value);
  },
};

interface GatewayContextValue {
  client: GatewayClient | null;
  gateway: GatewayConnection | null;
  setGateway: (gw: GatewayConnection) => void;
  unreadCount: number;
  incrementUnread: () => void;
  clearUnread: () => void;
}

const GatewayContext = createContext<GatewayContextValue>({
  client: null,
  gateway: null,
  setGateway: () => {},
  unreadCount: 0,
  incrementUnread: () => {},
  clearUnread: () => {},
});

export function useGateway() {
  return use(GatewayContext);
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_700Bold,
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    Geist_800ExtraBold,
  });

  useEffect(() => startMobileThemeController(), []);

  useEffect(() => {
    if (!fontsLoaded) return;

    let cancelled = false;
    nativeSplashRegistration.then((registered) => {
      if (cancelled || (!registered && !nativeSplashRegistered)) return;
      void SplashScreen.hideAsync().catch((err: unknown) => {
        console.warn("[mobile] Native splash screen could not be hidden:", err);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    // Still behind the native splash, and drawn to match it -- see StartupScreen
    // for why the title waits for its font.
    return <StartupScreen showTitle={false} />;
  }

  if (!clerkPublishableKey) {
    return <MissingClerkConfigScreen />;
  }

  return (
    <ClerkProvider publishableKey={clerkPublishableKey} tokenCache={tokenCache}>
      <QueryClientProvider client={mobileQueryClient}>
        <AnalyticsProvider>
          <BiometricGate>
            <GatewayShell />
          </BiometricGate>
        </AnalyticsProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

// Face ID / Touch ID only guards an existing signed-in session -- there is
// nothing to protect before the user has signed in, so the sign-in screen
// itself never prompts for biometrics.
function BiometricGate({ children }: { children: React.ReactNode }) {
  const { theme } = useUnistyles();
  const { isLoaded, isSignedIn } = useAuth();
  const [authenticated, setAuthenticated] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setAuthenticated(true);
      return;
    }
    let cancelled = false;
    // react-doctor-disable-next-line react-doctor/no-initialize-state -- intentional: `authenticated` derives from an async biometric check (authenticateBiometric); there is no synchronous initializer and useSyncExternalStore does not apply to a one-shot promise. Starts undefined and resolves once.
    authenticateBiometric().then((authed) => {
      if (!cancelled) setAuthenticated(authed);
    });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn]);

  if (!isLoaded || authenticated === undefined) {
    return (
      <StartupScreen>
        <ActivityIndicator size="large" color={theme.colors.primary} style={styles.loadingSpinner} />
      </StartupScreen>
    );
  }

  if (!authenticated) {
    return (
      <StartupScreen>
        <Text style={styles.loadingSubtitle}>Authenticating…</Text>
        <ActivityIndicator size="large" color={theme.colors.primary} style={styles.loadingSpinner} />
      </StartupScreen>
    );
  }

  return <>{children}</>;
}

// Wraps the app in PostHog's provider when analytics is enabled (key present).
// Screen autocapture is disabled because expo-router does not expose a
// react-navigation ref; screens are tracked manually via <AnalyticsScreenTracker />.
function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const analyticsClient = useMemo(() => getAnalyticsClient(), []);
  if (!analyticsClient) return <>{children}</>;
  return (
    <PostHogProvider client={analyticsClient} autocapture={{ captureScreens: false, captureTouches: false }}>
      {children}
    </PostHogProvider>
  );
}

// Manual expo-router screen tracking: capture a sanitized route name on every
// navigation. Params/ids are stripped in sanitizeScreenName so no handles,
// thread ids, or slugs reach analytics.
function AnalyticsScreenTracker() {
  const pathname = usePathname();
  useEffect(() => {
    captureScreen(sanitizeScreenName(pathname));
  }, [pathname]);
  return null;
}

function MissingClerkConfigScreen() {
  return (
    <StartupScreen>
      <Text style={styles.configTitle}>Missing mobile auth config</Text>
      <Text style={styles.configBody}>
        Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY before starting Expo.
      </Text>
    </StartupScreen>
  );
}

function GatewayShell() {
  const { theme } = useUnistyles();
  const { isLoaded, isSignedIn, getToken, userId } = useAuth();
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [gateway, setGatewayState] = useState<GatewayConnection | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const getTokenRef = useRef(getToken);
  const connectionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  // Associate analytics with the Clerk user id (id only) once signed in.
  useEffect(() => {
    if (isSignedIn && userId) identifyUser(userId);
  }, [isSignedIn, userId]);

  const incrementUnread = useCallback(() => {
    setUnreadCount((c) => c + 1);
  }, []);

  const clearUnread = useCallback(() => {
    setUnreadCount(0);
  }, []);

  // The client is held for its REST helpers and terminal WebSocket URLs only.
  // Chat runs over the canonical event stream and nothing consumes the legacy
  // main chat WebSocket, so it is never opened here; the terminal mints its
  // own ws-token on each attach.
  const setGateway = useCallback((gw: GatewayConnection) => {
    const nextKey = `${gw.url}:${gw.token ?? ""}`;
    if (connectionKeyRef.current === nextKey) return;
    connectionKeyRef.current = nextKey;
    // Hosted computers carry no stored credential: authenticate with the live
    // Clerk token provider, mirroring the mount path. Self-hosted gateways
    // keep their session credential.
    const newClient = gw.token
      ? new GatewayClient(gw.url, gw.token)
      : new GatewayClient(gw.url, () => getTokenRef.current());
    setClient(newClient);
    setGatewayState(gw);
  }, []);

  useEffect(() => {
    if (!isLoaded) return;

    let cancelled = false;

    async function selectGatewayClient() {
      const selectedGateway = await getSelectedGatewayConnection();
      if (cancelled) return;

      if (!isSignedIn) {
        if (!isHostedGatewayUrl(selectedGateway.url) && selectedGateway.token) {
          const nextKey = `${selectedGateway.url}:${selectedGateway.token}`;
          if (connectionKeyRef.current === nextKey) return;
          connectionKeyRef.current = nextKey;

          setClient(new GatewayClient(selectedGateway.url, selectedGateway.token));
          setGatewayState(selectedGateway);
          return;
        }

        if (connectionKeyRef.current === null) return;
        connectionKeyRef.current = null;
        setClient(null);
        setGatewayState(null);
        return;
      }

      const token = await getTokenRef.current();
      if (cancelled) return;
      if (!token) {
        connectionKeyRef.current = null;
        setClient(null);
        setGatewayState(null);
        console.warn("[mobile] Clerk is signed in but no session token was available for Matrix OS");
        return;
      }

      const authenticatedGateway: GatewayConnection = {
        ...selectedGateway,
        token: selectedGateway.token ?? token,
      };
      const nextKey = `${authenticatedGateway.url}:${authenticatedGateway.token ?? ""}`;
      if (connectionKeyRef.current === nextKey) return;
      connectionKeyRef.current = nextKey;

      setClient(selectedGateway.token
        ? new GatewayClient(authenticatedGateway.url, selectedGateway.token)
        : new GatewayClient(authenticatedGateway.url, () => getTokenRef.current()));
      setGatewayState(authenticatedGateway);
    }

    selectGatewayClient();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn]);

  const contextValue = useMemo<GatewayContextValue>(
    () => ({ client, gateway, setGateway, unreadCount, incrementUnread, clearUnread }),
    [client, gateway, setGateway, unreadCount, incrementUnread, clearUnread],
  );

  return (
    <GestureHandlerRootView style={styles.flex}>
      <GatewayContext.Provider value={contextValue}>
        <CanonicalChatSessionProvider>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: theme.colors.background },
              headerTintColor: theme.colors.foreground,
              headerTitleStyle: { fontFamily: theme.fonts.sansSemiBold },
              contentStyle: { backgroundColor: theme.colors.background },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="(drawer)" options={{ headerShown: false }} />
            <Stack.Screen name="file-browser" options={{ headerShown: false, presentation: "fullScreenModal" }} />
            <Stack.Screen name="terminal-session" options={{ headerShown: false, presentation: "fullScreenModal" }} />
            <Stack.Screen name="app-preview" options={{ headerShown: false, presentation: "fullScreenModal" }} />
            <Stack.Screen name="integrations-installed" options={{ headerShown: false, presentation: "fullScreenModal" }} />
            <Stack.Screen name="integration-detail" options={{ headerShown: false, presentation: "fullScreenModal" }} />
            <Stack.Screen name="settings-detail" options={{ headerShown: false, presentation: "fullScreenModal" }} />
            <Stack.Screen
              name="sign-in"
              options={{
                headerShown: false,
                presentation: "modal",
              }}
            />
            <Stack.Screen
              name="sign-in-computer"
              options={{
                title: "Sign in with computer URL",
                presentation: "modal",
                headerStyle: { backgroundColor: theme.v2.appColors.canvas },
                headerTintColor: theme.v2.appColors.ink,
              }}
            />
          </Stack>
          <NotificationRouter />
          <OtaUpdatePrompt />
          <AnalyticsScreenTracker />
          <StatusBar style="dark" />
        </CanonicalChatSessionProvider>
      </GatewayContext.Provider>
    </GestureHandlerRootView>
  );
}

function NotificationRouter() {
  const router = useRouter();
  const routerRef = useRef(router);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    const sub = addNotificationResponseListener((response) => {
      handleNotificationTap(response, routerRef.current);
    });
    return () => sub.remove();
  }, []);

  return null;
}

const styles = StyleSheet.create((theme) => ({
  flex: {
    flex: 1,
  },
  loadingSubtitle: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.mutedForeground,
    marginTop: 8,
  },
  loadingSpinner: {
    marginTop: 24,
  },
  configTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 16,
    color: theme.colors.foreground,
    marginTop: 16,
  },
  configBody: {
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    color: theme.colors.mutedForeground,
    marginTop: 8,
    maxWidth: 300,
    textAlign: "center",
  },
}));
