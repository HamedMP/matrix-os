import "@/lib/hermes-polyfills";
import "@/lib/unistyles";
import { use, useEffect, useMemo, useState, createContext, useCallback, useRef } from "react";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View, Text, ActivityIndicator } from "react-native";
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
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ClerkProvider, useAuth } from "@clerk/clerk-expo";
import { GatewayClient, type ConnectionState } from "@/lib/gateway-client";
import { getSelectedGatewayConnection, isHostedGatewayUrl, type GatewayConnection } from "@/lib/storage";
import { authenticateBiometric } from "@/lib/auth";
import { addNotificationResponseListener, handleNotificationTap } from "@/lib/push";

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
  connectionState: ConnectionState;
  gateway: GatewayConnection | null;
  setGateway: (gw: GatewayConnection) => void;
  unreadCount: number;
  incrementUnread: () => void;
  clearUnread: () => void;
}

const GatewayContext = createContext<GatewayContextValue>({
  client: null,
  connectionState: "disconnected",
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
  const { theme } = useUnistyles();
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_700Bold,
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
  });

  const [authenticated, setAuthenticated] = useState<boolean | undefined>(undefined);
  const ready = authenticated !== undefined;

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const authed = await authenticateBiometric();
      if (!cancelled) setAuthenticated(authed);
    }

    // react-doctor-disable-next-line react-doctor/no-initialize-state -- intentional: `authenticated` derives from an async biometric check (authenticateBiometric); there is no synchronous initializer and useSyncExternalStore does not apply to a one-shot promise. Starts undefined and resolves once.
    init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!fontsLoaded || !ready) return;

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
  }, [fontsLoaded, ready]);

  if (!fontsLoaded || !ready) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingTitle}>Matrix OS</Text>
        <ActivityIndicator size="large" color={theme.colors.primary} style={styles.loadingSpinner} />
      </View>
    );
  }

  if (!authenticated) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingTitle}>Matrix OS</Text>
        <Text style={styles.loadingSubtitle}>Authenticating…</Text>
        <ActivityIndicator size="large" color={theme.colors.primary} style={styles.loadingSpinner} />
      </View>
    );
  }

  if (!clerkPublishableKey) {
    return <MissingClerkConfigScreen />;
  }

  return (
    <ClerkProvider publishableKey={clerkPublishableKey} tokenCache={tokenCache}>
      <GatewayShell />
    </ClerkProvider>
  );
}

function MissingClerkConfigScreen() {
  return (
    <View style={styles.loadingContainer}>
      <Text style={styles.loadingTitle}>Matrix OS</Text>
      <Text style={styles.configTitle}>Missing mobile auth config</Text>
      <Text style={styles.configBody}>
        Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY before starting Expo.
      </Text>
    </View>
  );
}

function GatewayShell() {
  const { theme } = useUnistyles();
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [gateway, setGatewayState] = useState<GatewayConnection | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const getTokenRef = useRef(getToken);
  const connectionKeyRef = useRef<string | null>(null);
  const clientRef = useRef<GatewayClient | null>(null);

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const incrementUnread = useCallback(() => {
    setUnreadCount((c) => c + 1);
  }, []);

  const clearUnread = useCallback(() => {
    setUnreadCount(0);
  }, []);

  const setGateway = useCallback((gw: GatewayConnection) => {
    const nextKey = `${gw.url}:${gw.token ?? ""}`;
    if (connectionKeyRef.current === nextKey) return;
    connectionKeyRef.current = nextKey;
    clientRef.current?.disconnect();
    // Hosted computers carry no stored credential: authenticate with the live
    // Clerk token provider and a fresh WS upgrade token, mirroring the mount
    // path. Self-hosted gateways keep their session credential.
    const newClient = gw.token
      ? new GatewayClient(gw.url, gw.token)
      : new GatewayClient(gw.url, () => getTokenRef.current());
    newClient.onStateChange(setConnectionState);
    clientRef.current = newClient;
    setClient(newClient);
    setGatewayState(gw);
    setConnectionState("connecting");
    void (async () => {
      // A failed token fetch must not strand the switch at "connecting":
      // fall back to connecting with header auth, mirroring the mount path.
      try {
        const wsToken = await newClient.getWsToken();
        if (clientRef.current !== newClient) return;
        if (wsToken) newClient.setWebSocketToken(wsToken);
      } catch (err: unknown) {
        console.warn("[mobile] ws-token unavailable during switch", err instanceof Error ? err.name : typeof err);
        if (clientRef.current !== newClient) return;
      }
      newClient.connect();
    })();
  }, []);

  useEffect(() => {
    if (!isLoaded) return;

    let cancelled = false;

    async function connectSelectedGateway() {
      const selectedGateway = await getSelectedGatewayConnection();
      if (cancelled) return;

      if (!isSignedIn) {
        if (!isHostedGatewayUrl(selectedGateway.url) && selectedGateway.token) {
          const nextKey = `${selectedGateway.url}:${selectedGateway.token}`;
          if (connectionKeyRef.current === nextKey) return;
          connectionKeyRef.current = nextKey;

          clientRef.current?.disconnect();
          const nextClient = new GatewayClient(selectedGateway.url, selectedGateway.token);
          clientRef.current = nextClient;
          setClient(nextClient);
          setGatewayState(selectedGateway);
          setConnectionState("connecting");
          nextClient.onStateChange(setConnectionState);
          const wsToken = await nextClient.getWsToken();
          if (cancelled || clientRef.current !== nextClient) return;
          if (wsToken) nextClient.setWebSocketToken(wsToken);
          nextClient.connect();
          return;
        }

        if (connectionKeyRef.current === null) return;
        connectionKeyRef.current = null;
        clientRef.current?.disconnect();
        clientRef.current = null;
        setClient(null);
        setGatewayState(null);
        setConnectionState("disconnected");
        return;
      }

      const token = await getTokenRef.current();
      if (cancelled) return;
      if (!token) {
        connectionKeyRef.current = null;
        clientRef.current?.disconnect();
        clientRef.current = null;
        setClient(null);
        setGatewayState(null);
        setConnectionState("disconnected");
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

      clientRef.current?.disconnect();
      const nextClient = selectedGateway.token
        ? new GatewayClient(authenticatedGateway.url, selectedGateway.token)
        : new GatewayClient(authenticatedGateway.url, () => getTokenRef.current());
      clientRef.current = nextClient;
      setClient(nextClient);
      setGatewayState(authenticatedGateway);
      setConnectionState("connecting");

      nextClient.onStateChange(setConnectionState);
      const wsToken = await nextClient.getWsToken();
      if (cancelled || clientRef.current !== nextClient) return;
      if (!wsToken) {
        console.warn("[mobile] ws-token unavailable, connecting without upgrade token");
        nextClient.connect();
        return;
      }
      nextClient.setWebSocketToken(wsToken);
      nextClient.connect();
    }

    connectSelectedGateway();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn]);

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: read the latest client on unmount; the client is assigned by a later effect, so capturing clientRef.current at mount (null) would skip disconnect.
  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, []);

  const contextValue = useMemo<GatewayContextValue>(
    () => ({ client, connectionState, gateway, setGateway, unreadCount, incrementUnread, clearUnread }),
    [client, connectionState, gateway, setGateway, unreadCount, incrementUnread, clearUnread],
  );

  return (
    <GestureHandlerRootView style={styles.flex}>
      <GatewayContext.Provider value={contextValue}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.colors.background },
            headerTintColor: theme.colors.foreground,
            headerTitleStyle: { fontFamily: theme.fonts.sansSemiBold },
            contentStyle: { backgroundColor: theme.colors.background },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="apps" options={{ headerShown: false }} />
          <Stack.Screen name="runtime" options={{ headerShown: false }} />
          <Stack.Screen name="canvas/index" options={{ headerShown: false }} />
          <Stack.Screen name="agents" options={{ headerShown: false }} />
          <Stack.Screen name="sessions" options={{ headerShown: false, presentation: "modal" }} />
          <Stack.Screen
            name="computers"
            options={{
              title: "Computers",
              headerBackButtonDisplayMode: "minimal",
              headerStyle: { backgroundColor: theme.colors.background },
            }}
          />
          <Stack.Screen
            name="connect"
            options={{
              title: "Gateway",
              presentation: "modal",
              headerStyle: { backgroundColor: theme.colors.background },
            }}
          />
          <Stack.Screen
            name="sign-in"
            options={{
              title: "Sign In",
              presentation: "modal",
              headerStyle: { backgroundColor: theme.colors.background },
            }}
          />
        </Stack>
        <NotificationRouter />
        <StatusBar style="dark" />
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
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background,
  },
  loadingTitle: {
    fontFamily: theme.fonts.display,
    fontSize: 30,
    color: theme.colors.foreground,
    letterSpacing: -0.5,
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
