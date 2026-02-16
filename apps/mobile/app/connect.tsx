import { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
import { colors, fonts, spacing, radius } from "@/lib/theme";

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

  const canConnect = url.trim().length > 0 && !testing;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.sectionLabel}>CONNECT</Text>
          <Text style={styles.pageTitle}>Gateway Setup</Text>
          <Text style={styles.pageDescription}>
            Connect to a Matrix OS gateway running on your local network or in the cloud.
          </Text>
        </View>

        {savedGateways.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>Saved Gateways</Text>
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

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>Add New Gateway</Text>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Name</Text>
            <View style={styles.inputWrapper}>
              <Ionicons name="text-outline" size={18} color={colors.light.mutedForeground} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="My Mac (optional)"
                placeholderTextColor={colors.light.mutedForeground}
                autoCapitalize="none"
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Gateway URL</Text>
            <View style={styles.inputWrapper}>
              <Ionicons name="link-outline" size={18} color={colors.light.mutedForeground} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                value={url}
                onChangeText={setUrl}
                placeholder="http://192.168.1.100:4000"
                placeholderTextColor={colors.light.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Auth Token</Text>
            <View style={styles.inputWrapper}>
              <Ionicons name="key-outline" size={18} color={colors.light.mutedForeground} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                value={token}
                onChangeText={setToken}
                placeholder="Optional"
                placeholderTextColor={colors.light.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
            </View>
          </View>

          <View style={styles.buttonRow}>
            <Pressable
              onPress={handleTest}
              disabled={testing}
              style={({ pressed }) => [
                styles.testButton,
                pressed && styles.buttonPressed,
              ]}
            >
              {testing ? (
                <ActivityIndicator size="small" color={colors.light.primary} />
              ) : (
                <>
                  <Ionicons name="pulse-outline" size={16} color={colors.light.foreground} />
                  <Text style={styles.testButtonText}>Test</Text>
                </>
              )}
            </Pressable>
            <Pressable
              onPress={handleConnect}
              disabled={!canConnect}
              style={({ pressed }) => [
                styles.connectButton,
                !canConnect && styles.connectButtonDisabled,
                pressed && canConnect && styles.buttonPressed,
              ]}
            >
              {testing ? (
                <ActivityIndicator size="small" color={colors.light.primaryForeground} />
              ) : (
                <>
                  <Ionicons
                    name="arrow-forward"
                    size={16}
                    color={canConnect ? colors.light.primaryForeground : colors.light.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.connectButtonText,
                      !canConnect && styles.connectButtonTextDisabled,
                    ]}
                  >
                    Connect
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Matrix OS v0.3.0</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: colors.light.background,
  },
  scrollContent: {
    padding: spacing.xl,
    paddingBottom: 48,
  },
  header: {
    marginBottom: spacing["2xl"],
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.light.primary,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: spacing.sm,
  },
  pageTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 28,
    color: colors.light.foreground,
    letterSpacing: -0.5,
    marginBottom: spacing.sm,
  },
  pageDescription: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.mutedForeground,
    lineHeight: 20,
  },
  section: {
    marginBottom: spacing["2xl"],
  },
  sectionHeader: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
    color: colors.light.mutedForeground,
    marginBottom: spacing.md,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  inputGroup: {
    marginBottom: spacing.lg,
  },
  inputLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.light.foreground,
    marginBottom: 6,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    paddingHorizontal: spacing.md,
  },
  inputIcon: {
    marginRight: spacing.sm,
  },
  input: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.light.foreground,
    paddingVertical: 14,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: spacing.sm,
  },
  testButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    paddingVertical: 14,
  },
  testButtonText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
    color: colors.light.foreground,
  },
  connectButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: radius.lg,
    backgroundColor: colors.light.primary,
    paddingVertical: 14,
    shadowColor: colors.light.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 3,
  },
  connectButtonDisabled: {
    backgroundColor: colors.light.muted,
    shadowOpacity: 0,
    elevation: 0,
  },
  connectButtonText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
    color: colors.light.primaryForeground,
  },
  connectButtonTextDisabled: {
    color: colors.light.mutedForeground,
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  footer: {
    alignItems: "center",
    paddingVertical: spacing["2xl"],
  },
  footerText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.light.mutedForeground,
  },
});
