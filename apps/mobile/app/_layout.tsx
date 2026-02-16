import { useEffect, useState, createContext, useContext, useCallback } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import * as SplashScreen from "expo-splash-screen";
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
import { GatewayClient, type ConnectionState } from "@/lib/gateway-client";
import { getActiveGateway, type GatewayConnection } from "@/lib/storage";
import { authenticateBiometric } from "@/lib/auth";
import { colors, fonts } from "@/lib/theme";

import "../global.css";

SplashScreen.preventAutoHideAsync();

interface GatewayContextValue {
  client: GatewayClient | null;
  connectionState: ConnectionState;
  gateway: GatewayConnection | null;
  setGateway: (gw: GatewayConnection) => void;
}

const GatewayContext = createContext<GatewayContextValue>({
  client: null,
  connectionState: "disconnected",
  gateway: null,
  setGateway: () => {},
});

export function useGateway() {
  return useContext(GatewayContext);
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
      SplashScreen.hideAsync();
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
    <GestureHandlerRootView style={styles.flex}>
      <GatewayContext.Provider value={{ client, connectionState, gateway, setGateway }}>
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
              title: "Connect to Gateway",
              presentation: "modal",
              headerStyle: { backgroundColor: colors.light.background },
            }}
          />
        </Stack>
        <StatusBar style="dark" />
      </GatewayContext.Provider>
    </GestureHandlerRootView>
  );
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
