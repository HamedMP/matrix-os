import { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useGateway } from "./_layout";
import { GatewayClient } from "@/lib/gateway-client";
import {
  saveGateway,
  setActiveGatewayId,
  getGateways,
  removeGateway,
  generateId,
  type GatewayConnection,
} from "@/lib/storage";
import { GatewayCard } from "@/components/GatewayCard";

export default function ConnectScreen() {
  const router = useRouter();
  const { setGateway } = useGateway();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [testing, setTesting] = useState(false);
  const [savedGateways, setSavedGateways] = useState<GatewayConnection[]>([]);
  const [loaded, setLoaded] = useState(false);

  const loadGateways = useCallback(async () => {
    const gws = await getGateways();
    setSavedGateways(gws);
    setLoaded(true);
  }, []);

  if (!loaded) {
    loadGateways();
  }

  const handleTest = useCallback(async () => {
    const trimmedUrl = url.trim().replace(/\/+$/, "");
    if (!trimmedUrl) {
      Alert.alert("Error", "Please enter a gateway URL");
      return;
    }

    setTesting(true);
    const testClient = new GatewayClient(trimmedUrl, token.trim() || undefined);
    const result = await testClient.healthCheck();
    setTesting(false);

    if (result.ok) {
      Alert.alert("Success", "Gateway is reachable");
    } else {
      Alert.alert("Error", `Could not reach gateway: ${result.error}`);
    }
  }, [url, token]);

  const handleConnect = useCallback(async () => {
    const trimmedUrl = url.trim().replace(/\/+$/, "");
    if (!trimmedUrl) {
      Alert.alert("Error", "Please enter a gateway URL");
      return;
    }

    setTesting(true);
    const testClient = new GatewayClient(trimmedUrl, token.trim() || undefined);
    const result = await testClient.healthCheck();
    setTesting(false);

    if (!result.ok) {
      Alert.alert("Error", `Could not reach gateway: ${result.error}`);
      return;
    }

    const gw: GatewayConnection = {
      id: generateId(),
      url: trimmedUrl,
      token: token.trim() || undefined,
      name: name.trim() || trimmedUrl,
      addedAt: Date.now(),
    };

    await saveGateway(gw);
    await setActiveGatewayId(gw.id);
    setGateway(gw);
    router.replace("/(tabs)/chat");
  }, [url, token, name, setGateway, router]);

  const handleSelectGateway = useCallback(
    async (gw: GatewayConnection) => {
      await setActiveGatewayId(gw.id);
      setGateway(gw);
      router.replace("/(tabs)/chat");
    },
    [setGateway, router],
  );

  const handleRemoveGateway = useCallback(
    async (id: string) => {
      await removeGateway(id);
      setSavedGateways((prev) => prev.filter((g) => g.id !== id));
    },
    [],
  );

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24 }}>
      <Text className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
        Connect
      </Text>
      <Text className="mb-6 text-2xl font-bold text-foreground" style={{ fontFamily: "Inter_700Bold" }}>
        Gateway Setup
      </Text>

      {savedGateways.length > 0 && (
        <View className="mb-8">
          <Text className="mb-3 text-sm font-medium text-muted-foreground">
            Saved Gateways
          </Text>
          {savedGateways.map((gw) => (
            <GatewayCard
              key={gw.id}
              gateway={gw}
              onSelect={() => handleSelectGateway(gw)}
              onRemove={() => handleRemoveGateway(gw.id)}
            />
          ))}
        </View>
      )}

      <View className="mb-8">
        <Text className="mb-3 text-sm font-medium text-muted-foreground">
          Add New Gateway
        </Text>

        <View className="mb-3 rounded-xl border border-border bg-card p-1">
          <TextInput
            className="px-3 py-3 text-base text-foreground"
            style={{ fontFamily: "Inter_400Regular" }}
            value={name}
            onChangeText={setName}
            placeholder="Name (optional)"
            placeholderTextColor="#78716c"
            autoCapitalize="none"
          />
        </View>

        <View className="mb-3 rounded-xl border border-border bg-card p-1">
          <TextInput
            className="px-3 py-3 text-base text-foreground"
            style={{ fontFamily: "Inter_400Regular" }}
            value={url}
            onChangeText={setUrl}
            placeholder="http://192.168.1.100:4000"
            placeholderTextColor="#78716c"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>

        <View className="mb-4 rounded-xl border border-border bg-card p-1">
          <TextInput
            className="px-3 py-3 text-base text-foreground"
            style={{ fontFamily: "Inter_400Regular" }}
            value={token}
            onChangeText={setToken}
            placeholder="Auth token (optional)"
            placeholderTextColor="#78716c"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>

        <View className="flex-row gap-3">
          <Pressable
            onPress={handleTest}
            disabled={testing}
            className="flex-1 items-center rounded-xl border border-border bg-card py-3"
          >
            {testing ? (
              <ActivityIndicator size="small" color="#c2703a" />
            ) : (
              <Text className="text-sm font-medium text-foreground">Test</Text>
            )}
          </Pressable>
          <Pressable
            onPress={handleConnect}
            disabled={testing || !url.trim()}
            className={`flex-1 items-center rounded-xl py-3 ${
              url.trim() ? "bg-primary" : "bg-muted"
            }`}
          >
            {testing ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text
                className={`text-sm font-medium ${
                  url.trim() ? "text-primary-foreground" : "text-muted-foreground"
                }`}
              >
                Connect
              </Text>
            )}
          </Pressable>
        </View>
      </View>

      <View className="items-center py-8">
        <Text className="font-mono text-xs text-muted-foreground">
          Matrix OS v0.3.0
        </Text>
      </View>
    </ScrollView>
  );
}
