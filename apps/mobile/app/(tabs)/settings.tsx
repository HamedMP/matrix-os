import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Switch,
  Linking,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { useGateway } from "../_layout";
import { ChannelBadge } from "@/components/ChannelBadge";
import {
  getSettings,
  saveSettings,
  type AppSettings,
} from "@/lib/storage";
import { isBiometricAvailable, getSupportedBiometricTypes, getBiometricLabel } from "@/lib/auth";

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-6">
      <Text className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
        {title}
      </Text>
      <View className="gap-2">{children}</View>
    </View>
  );
}

function SettingsRow({
  label,
  value,
  onPress,
  right,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress && !right}
      className="flex-row items-center justify-between rounded-xl border border-border bg-card px-4 py-3"
    >
      <Text className="text-sm text-foreground" style={{ fontFamily: "Inter_500Medium" }}>
        {label}
      </Text>
      {value ? (
        <Text className="text-sm text-muted-foreground">{value}</Text>
      ) : right ? (
        right
      ) : null}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const { client, connectionState, gateway } = useGateway();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [channels, setChannels] = useState<Record<string, { status: string }>>({});
  const [systemInfo, setSystemInfo] = useState<Record<string, unknown> | null>(null);
  const [biometricLabel, setBiometricLabel] = useState("Biometric");
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    async function init() {
      const s = await getSettings();
      setSettings(s);

      const available = await isBiometricAvailable();
      setBiometricAvailable(available);

      if (available) {
        const types = await getSupportedBiometricTypes();
        setBiometricLabel(getBiometricLabel(types));
      }
    }
    init();
  }, []);

  const fetchRemote = useCallback(async () => {
    if (!client || connectionState !== "connected") return;
    try {
      const [chStatus, sysInfo] = await Promise.all([
        client.getChannelStatus(),
        client.getSystemInfo(),
      ]);
      setChannels(chStatus as Record<string, { status: string }>);
      setSystemInfo(sysInfo as Record<string, unknown>);
    } catch {
      // silently handle
    }
  }, [client, connectionState]);

  useEffect(() => {
    fetchRemote();
  }, [fetchRemote]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchRemote();
    setRefreshing(false);
  }, [fetchRemote]);

  const updateSetting = useCallback(
    async (key: keyof AppSettings, value: boolean | string) => {
      const updated = { [key]: value };
      await saveSettings(updated);
      setSettings((prev) => prev ? { ...prev, ...updated } : null);
    },
    [],
  );

  if (!settings) return null;

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 24 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#c2703a" />
      }
    >
      <SettingsSection title="Gateway">
        <SettingsRow
          label={gateway?.name ?? "Not connected"}
          value={connectionState === "connected" ? "Connected" : connectionState}
        />
        <Pressable
          onPress={() => router.push("/connect")}
          className="items-center rounded-xl border border-border bg-card py-3"
        >
          <Text className="text-sm font-medium text-primary">Manage Gateways</Text>
        </Pressable>
      </SettingsSection>

      <SettingsSection title="Channels">
        {Object.keys(channels).length > 0 ? (
          Object.entries(channels).map(([name, ch]) => (
            <ChannelBadge
              key={name}
              name={name}
              status={ch.status as "connected" | "error" | "degraded" | "not_configured"}
            />
          ))
        ) : (
          <Text className="text-sm text-muted-foreground">
            {connectionState === "connected"
              ? "No channels configured"
              : "Connect to view channels"}
          </Text>
        )}
      </SettingsSection>

      <SettingsSection title="Notifications">
        <SettingsRow
          label="Push Notifications"
          right={
            <Switch
              value={settings.notificationsEnabled}
              onValueChange={(v) => updateSetting("notificationsEnabled", v)}
              trackColor={{ false: "#d8d0de", true: "#c2703a" }}
              thumbColor="#ffffff"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Security">
        {biometricAvailable ? (
          <SettingsRow
            label={`${biometricLabel} Lock`}
            right={
              <Switch
                value={settings.biometricEnabled}
                onValueChange={(v) => updateSetting("biometricEnabled", v)}
                trackColor={{ false: "#d8d0de", true: "#c2703a" }}
                thumbColor="#ffffff"
              />
            }
          />
        ) : (
          <Text className="text-sm text-muted-foreground">
            No biometric authentication available
          </Text>
        )}
      </SettingsSection>

      <SettingsSection title="Appearance">
        <View className="flex-row gap-2">
          {(["system", "light", "dark"] as const).map((theme) => (
            <Pressable
              key={theme}
              onPress={() => updateSetting("theme", theme)}
              className={`flex-1 items-center rounded-xl py-2.5 ${
                settings.theme === theme
                  ? "bg-primary"
                  : "border border-border bg-card"
              }`}
            >
              <Text
                className={`text-xs font-medium capitalize ${
                  settings.theme === theme
                    ? "text-primary-foreground"
                    : "text-foreground"
                }`}
              >
                {theme}
              </Text>
            </Pressable>
          ))}
        </View>
      </SettingsSection>

      <SettingsSection title="About">
        <SettingsRow label="App Version" value="0.1.0" />
        {systemInfo && (
          <>
            <SettingsRow
              label="Gateway Version"
              value={String(systemInfo.version ?? "unknown")}
            />
            <SettingsRow
              label="Model"
              value={String(systemInfo.model ?? "unknown")}
            />
          </>
        )}
        <Pressable
          onPress={() => Linking.openURL("https://matrix-os.com")}
          className="items-center rounded-xl border border-border bg-card py-3"
        >
          <Text className="text-sm font-medium text-primary">matrix-os.com</Text>
        </Pressable>
      </SettingsSection>
    </ScrollView>
  );
}
