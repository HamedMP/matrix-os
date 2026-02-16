import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Switch,
  Linking,
  RefreshControl,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useGateway } from "../_layout";
import { ChannelBadge } from "@/components/ChannelBadge";
import {
  getSettings,
  saveSettings,
  type AppSettings,
} from "@/lib/storage";
import { isBiometricAvailable, getSupportedBiometricTypes, getBiometricLabel } from "@/lib/auth";
import { colors, fonts, spacing, radius } from "@/lib/theme";

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionContent}>{children}</View>
    </View>
  );
}

function SettingsRow({
  label,
  value,
  icon,
  onPress,
  right,
}: {
  label: string;
  value?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress && !right}
      style={({ pressed }) => [
        styles.row,
        pressed && onPress && styles.rowPressed,
      ]}
    >
      <View style={styles.rowLeft}>
        {icon && (
          <View style={styles.rowIcon}>
            <Ionicons name={icon} size={18} color={colors.light.primary} />
          </View>
        )}
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
      {value ? (
        <Text style={styles.rowValue}>{value}</Text>
      ) : right ? (
        right
      ) : onPress ? (
        <Ionicons name="chevron-forward" size={16} color={colors.light.mutedForeground} />
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
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.light.primary} />
      }
    >
      <SettingsSection title="Gateway">
        <SettingsRow
          label={gateway?.name ?? "Not connected"}
          icon="server-outline"
          value={connectionState === "connected" ? "Connected" : connectionState}
        />
        <Pressable
          onPress={() => router.push("/connect")}
          style={({ pressed }) => [
            styles.actionButton,
            pressed && styles.rowPressed,
          ]}
        >
          <Text style={styles.actionButtonText}>Manage Gateways</Text>
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
          <View style={styles.emptyRow}>
            <Ionicons name="radio-outline" size={16} color={colors.light.mutedForeground} />
            <Text style={styles.emptyText}>
              {connectionState === "connected"
                ? "No channels configured"
                : "Connect to view channels"}
            </Text>
          </View>
        )}
      </SettingsSection>

      <SettingsSection title="Notifications">
        <SettingsRow
          label="Push Notifications"
          icon="notifications-outline"
          right={
            <Switch
              value={settings.notificationsEnabled}
              onValueChange={(v) => updateSetting("notificationsEnabled", v)}
              trackColor={{ false: colors.light.border, true: colors.light.primary }}
              thumbColor="#ffffff"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Security">
        {biometricAvailable ? (
          <SettingsRow
            label={`${biometricLabel} Lock`}
            icon="finger-print-outline"
            right={
              <Switch
                value={settings.biometricEnabled}
                onValueChange={(v) => updateSetting("biometricEnabled", v)}
                trackColor={{ false: colors.light.border, true: colors.light.primary }}
                thumbColor="#ffffff"
              />
            }
          />
        ) : (
          <View style={styles.emptyRow}>
            <Ionicons name="lock-closed-outline" size={16} color={colors.light.mutedForeground} />
            <Text style={styles.emptyText}>No biometric authentication available</Text>
          </View>
        )}
      </SettingsSection>

      <SettingsSection title="Appearance">
        <View style={styles.themeRow}>
          {(["system", "light", "dark"] as const).map((theme) => {
            const isActive = settings.theme === theme;
            const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
              system: "phone-portrait-outline",
              light: "sunny-outline",
              dark: "moon-outline",
            };
            return (
              <Pressable
                key={theme}
                onPress={() => updateSetting("theme", theme)}
                style={[
                  styles.themeOption,
                  isActive ? styles.themeOptionActive : styles.themeOptionInactive,
                ]}
              >
                <Ionicons
                  name={icons[theme]}
                  size={16}
                  color={isActive ? colors.light.primaryForeground : colors.light.foreground}
                />
                <Text
                  style={[
                    styles.themeOptionText,
                    isActive ? styles.themeOptionTextActive : styles.themeOptionTextInactive,
                  ]}
                >
                  {theme.charAt(0).toUpperCase() + theme.slice(1)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </SettingsSection>

      <SettingsSection title="About">
        <SettingsRow label="App Version" icon="information-circle-outline" value="0.1.0" />
        {systemInfo && (
          <>
            <SettingsRow
              label="Gateway Version"
              icon="code-slash-outline"
              value={String(systemInfo.version ?? "unknown")}
            />
            <SettingsRow
              label="Model"
              icon="hardware-chip-outline"
              value={String(systemInfo.model ?? "unknown")}
            />
          </>
        )}
        <Pressable
          onPress={() => Linking.openURL("https://matrix-os.com")}
          style={({ pressed }) => [
            styles.actionButton,
            pressed && styles.rowPressed,
          ]}
        >
          <Ionicons name="globe-outline" size={16} color={colors.light.primary} />
          <Text style={styles.actionButtonText}>matrix-os.com</Text>
        </Pressable>
      </SettingsSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light.background,
  },
  scrollContent: {
    padding: spacing.xl,
    paddingBottom: 48,
  },
  section: {
    marginBottom: spacing.xl,
  },
  sectionTitle: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.light.primary,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: spacing.sm,
  },
  sectionContent: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowPressed: {
    opacity: 0.8,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    flex: 1,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.light.secondary,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.light.foreground,
    flex: 1,
  },
  rowValue: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.light.mutedForeground,
  },
  emptyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  emptyText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.light.mutedForeground,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    paddingVertical: spacing.md,
  },
  actionButtonText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
    color: colors.light.primary,
  },
  themeRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  themeOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: radius.lg,
    paddingVertical: 10,
  },
  themeOptionActive: {
    backgroundColor: colors.light.primary,
  },
  themeOptionInactive: {
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
  },
  themeOptionText: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
  },
  themeOptionTextActive: {
    color: colors.light.primaryForeground,
  },
  themeOptionTextInactive: {
    color: colors.light.foreground,
  },
});
