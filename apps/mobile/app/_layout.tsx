import { use, useEffect, useState, createContext, useCallback, useRef } from "react";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
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
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ClerkProvider } from "@clerk/clerk-expo";
import { GatewayClient, type ConnectionState } from "@/lib/gateway-client";
import { getActiveGateway, type GatewayConnection } from "@/lib/storage";
import { authenticateBiometric } from "@/lib/auth";
import { addNotificationResponseListener, handleNotificationTap } from "@/lib/push";
import { colors, fonts } from "@/lib/theme";

import "../global.css";

SplashScreen.preventAutoHideAsync().catch(() => {});

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
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_700Bold,
  });

  const [client, setClient] = useState<GatewayClient | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [gateway, setGatewayState] = useState<GatewayConnection | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [ready, setReady] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const incrementUnread = useCallback(() => {
    setUnreadCount((c) => c + 1);
  }, []);

  const clearUnread = useCallback(() => {
    setUnreadCount(0);
  }, []);

  const setGateway = useCallback((gw: GatewayConnection) => {
    client?.disconnect();
    const newClient = new GatewayClient(gw.url, gw.token);
    newClient.onStateChange(setConnectionState);
    newClient.connect();
    setClient(newClient);
    setGatewayState(gw);
  }, [client]);

  useEffect(() => {
    async function init() {
      const authed = await authenticateBiometric();
      setAuthenticated(authed);

      const savedGateway = await getActiveGateway();
      if (savedGateway) {
        const gw = new GatewayClient(savedGateway.url, savedGateway.token);
        gw.onStateChange(setConnectionState);
        gw.connect();
        setClient(gw);
        setGatewayState(savedGateway);
      }

      setReady(true);
    }

    init();
  }, []);

  useEffect(() => {
    if (fontsLoaded && ready) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, ready]);

  if (!fontsLoaded || !ready) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingTitle}>Matrix OS</Text>
        <ActivityIndicator size="large" color={colors.light.primary} style={styles.loadingSpinner} />
      </View>
    );
  }

  if (!authenticated) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingTitle}>Matrix OS</Text>
        <Text style={styles.loadingSubtitle}>Authenticating...</Text>
        <ActivityIndicator size="large" color={colors.light.primary} style={styles.loadingSpinner} />
      </View>
    );
  }

  return (
    <ClerkProvider tokenCache={tokenCache}>
      <GestureHandlerRootView style={styles.flex}>
        <GatewayContext.Provider value={{ client, connectionState, gateway, setGateway, unreadCount, incrementUnread, clearUnread }}>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.light.background },
              headerTintColor: colors.light.foreground,
              headerTitleStyle: { fontFamily: fonts.sansSemiBold },
              contentStyle: { backgroundColor: colors.light.background },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen
              name="connect"
              options={{
                title: "Self-hosted Gateway",
                presentation: "modal",
                headerStyle: { backgroundColor: colors.light.background },
              }}
            />
            <Stack.Screen
              name="sign-in"
              options={{
                title: "Sign In",
                presentation: "modal",
                headerStyle: { backgroundColor: colors.light.background },
              }}
            />
          </Stack>
          <NotificationRouter />
          <StatusBar style="dark" />
        </GatewayContext.Provider>
      </GestureHandlerRootView>
    </ClerkProvider>
  );
}

function NotificationRouter() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    const sub = addNotificationResponseListener((response) => {
      handleNotificationTap(response, routerRef.current);
    });
    return () => sub.remove();
  }, []);

  return null;
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light.background,
  },
  loadingTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 28,
    color: colors.light.foreground,
    letterSpacing: -0.5,
  },
  loadingSubtitle: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.mutedForeground,
    marginTop: 8,
  },
  loadingSpinner: {
    marginTop: 24,
  },
});
