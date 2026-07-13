import "@/lib/hermes-polyfills";
import { useEffect, useReducer, useCallback, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Switch,
  Linking,
  RefreshControl,
  Alert,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { useGateway } from "../_layout";
import { ChannelBadge } from "@/components/ChannelBadge";
import {
  getSettings,
  saveSettings,
  type AppSettings,
} from "@/lib/storage";
import { isBiometricAvailable, getSupportedBiometricTypes, getBiometricLabel } from "@/lib/auth";
import { clearAllScrollback } from "@/lib/terminal-scrollback";

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
  tone = "default",
}: {
  label: string;
  value?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  right?: React.ReactNode;
  tone?: "default" | "danger";
}) {
  const { theme } = useUnistyles();
  const isDanger = tone === "danger";
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
          <View style={isDanger ? styles.rowIconDanger : styles.rowIcon}>
            <Ionicons name={icon} size={18} color={isDanger ? theme.colors.destructive : theme.colors.primary} />
          </View>
        )}
        <Text style={isDanger ? styles.rowLabelDanger : styles.rowLabel}>{label}</Text>
      </View>
      {value ? (
        <Text selectable style={styles.rowValue}>{value}</Text>
      ) : right ? (
        right
      ) : onPress ? (
        <Ionicons name="chevron-forward" size={16} color={theme.colors.mutedForeground} />
      ) : null}
    </Pressable>
  );
}

interface SettingsState {
  settings: AppSettings | null;
  channels: Record<string, { status: string }>;
  systemInfo: Record<string, unknown> | null;
  aiProfile: string | null;
  biometricLabel: string;
  biometricAvailable: boolean;
  refreshing: boolean;
}

type SettingsAction =
  | { type: "localLoaded"; settings: AppSettings; biometricAvailable: boolean; biometricLabel: string }
  | { type: "remoteLoaded"; channels: Record<string, { status: string }>; systemInfo: Record<string, unknown>; aiProfile: string | null }
  | { type: "settingsPatched"; patch: Partial<AppSettings> }
  | { type: "refreshing"; value: boolean };

const INITIAL_SETTINGS_STATE: SettingsState = {
  settings: null,
  channels: {},
  systemInfo: null,
  aiProfile: null,
  biometricLabel: "Biometric",
  biometricAvailable: false,
  refreshing: false,
};

function settingsReducer(state: SettingsState, action: SettingsAction): SettingsState {
  switch (action.type) {
    case "localLoaded":
      return {
        ...state,
        settings: action.settings,
        biometricAvailable: action.biometricAvailable,
        biometricLabel: action.biometricLabel,
      };
    case "remoteLoaded":
      return {
        ...state,
        channels: action.channels,
        systemInfo: action.systemInfo,
        aiProfile: action.aiProfile,
      };
    case "settingsPatched":
      return {
        ...state,
        settings: state.settings ? { ...state.settings, ...action.patch } : null,
      };
    case "refreshing":
      return { ...state, refreshing: action.value };
    default:
      return state;
  }
}

export default function SettingsScreen() {
  const router = useRouter();
  const { signOut } = useAuth();
  const { client, connectionState, gateway } = useGateway();
  const [state, dispatch] = useReducer(settingsReducer, INITIAL_SETTINGS_STATE);
  const { settings, channels, systemInfo, aiProfile, biometricLabel, biometricAvailable, refreshing } = state;

  useEffect(() => {
    async function init() {
      const [s, available] = await Promise.all([getSettings(), isBiometricAvailable()]);
      const label = available ? getBiometricLabel(await getSupportedBiometricTypes()) : "Biometric";
      dispatch({ type: "localLoaded", settings: s, biometricAvailable: available, biometricLabel: label });
    }
    init();
  }, []);

  const fetchRemote = useCallback(async () => {
    if (!client) return;
    try {
      const [chStatus, sysInfo, profile] = await Promise.all([
        client.getChannelStatus(),
        client.getSystemInfo(),
        client.getAiProfile(),
      ]);
      dispatch({
        type: "remoteLoaded",
        channels: chStatus as Record<string, { status: string }>,
        systemInfo: sysInfo as Record<string, unknown>,
        aiProfile: profile,
      });
    } catch {
      // silently handle
    }
  }, [client]);

  useEffect(() => {
    fetchRemote();
  }, [fetchRemote]);

  const handleRefresh = useCallback(async () => {
    dispatch({ type: "refreshing", value: true });
    await fetchRemote();
    dispatch({ type: "refreshing", value: false });
  }, [fetchRemote]);

  const updateSetting = useCallback(
    async (key: keyof AppSettings, value: boolean | string) => {
      const patch = { [key]: value };
      await saveSettings(patch);
      dispatch({ type: "settingsPatched", patch });
    },
    [],
  );

  const handleSignOut = useCallback(() => {
    Alert.alert("Sign out?", "You’ll return to sign in and can choose a Matrix OS computer URL.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          clearAllScrollback();
          void signOut()
            .then(() => router.replace("/sign-in" as any))
            .catch((err: unknown) => {
              console.warn("[mobile] sign-out failed", err instanceof Error ? err.message : String(err));
              Alert.alert("Sign out failed", "Try again in a moment.");
            });
        },
      },
    ]);
  }, [router, signOut]);

  const handleSwitchComputer = useCallback(() => {
    router.push("/computers" as never);
  }, [router]);

  if (!settings) return null;

  return (
    <SettingsContent
      settings={settings}
      channels={channels}
      systemInfo={systemInfo}
      aiProfile={aiProfile}
      biometricLabel={biometricLabel}
      biometricAvailable={biometricAvailable}
      refreshing={refreshing}
      connectionState={connectionState}
      gatewayName={gateway?.name ?? null}
      gatewayUrl={gateway?.url ?? null}
      onRefresh={handleRefresh}
      updateSetting={updateSetting}
      onSwitchComputer={handleSwitchComputer}
      onSignOut={handleSignOut}
    />
  );
}

interface SettingsContentProps {
  settings: AppSettings;
  channels: Record<string, { status: string }>;
  systemInfo: Record<string, unknown> | null;
  aiProfile: string | null;
  biometricLabel: string;
  biometricAvailable: boolean;
  refreshing: boolean;
  connectionState: string;
  gatewayName: string | null;
  gatewayUrl: string | null;
  onRefresh: () => void;
  updateSetting: (key: keyof AppSettings, value: boolean | string) => void;
  onSwitchComputer: () => void;
  onSignOut: () => void;
}

export function SettingsContent({
  settings,
  channels,
  systemInfo,
  aiProfile,
  biometricLabel,
  biometricAvailable,
  refreshing,
  connectionState,
  gatewayName,
  gatewayUrl,
  onRefresh,
  updateSetting,
  onSwitchComputer,
  onSignOut,
}: SettingsContentProps) {
  const { theme: uniTheme } = useUnistyles();
  const refreshControl = useMemo(
    () => (
      <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={uniTheme.colors.primary} />
    ),
    [refreshing, onRefresh, uniTheme.colors.primary],
  );

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={refreshControl}
    >
      <SettingsSection title="Gateway">
        <SettingsRow
          label={gatewayName ?? "Not connected"}
          icon="server-outline"
          value={gatewayUrl ?? connectionState}
        />
        <SettingsRow
          label="Switch computer"
          icon="swap-horizontal-outline"
          onPress={onSwitchComputer}
        />
      </SettingsSection>

      <SettingsSection title="Agent">
        {aiProfile ? (
          <View style={styles.profileCard}>
            <Text selectable style={styles.profileText} numberOfLines={8}>
              {aiProfile}
            </Text>
          </View>
        ) : (
          <View style={styles.emptyRow}>
            <Ionicons name="person-circle-outline" size={16} color={uniTheme.colors.mutedForeground} />
            <Text style={styles.emptyText}>
              {connectionState === "connected"
                ? "No agent profile configured"
                : "Connect to view agent profile"}
            </Text>
          </View>
        )}
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
            <Ionicons name="radio-outline" size={16} color={uniTheme.colors.mutedForeground} />
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
              trackColor={{ false: uniTheme.colors.border, true: uniTheme.colors.primary }}
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
                trackColor={{ false: uniTheme.colors.border, true: uniTheme.colors.primary }}
                thumbColor="#ffffff"
              />
            }
          />
        ) : (
          <View style={styles.emptyRow}>
            <Ionicons name="lock-closed-outline" size={16} color={uniTheme.colors.mutedForeground} />
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
                  color={isActive ? uniTheme.colors.primaryForeground : uniTheme.colors.foreground}
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
          <Ionicons name="globe-outline" size={16} color={uniTheme.colors.primary} />
          <Text style={styles.actionButtonText}>matrix-os.com</Text>
        </Pressable>
      </SettingsSection>

      <SettingsSection title="Account">
        <SettingsRow
          label="Sign out"
          icon="log-out-outline"
          tone="danger"
          onPress={onSignOut}
        />
      </SettingsSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scrollContent: {
    padding: theme.spacing.xl,
    paddingBottom: 48,
  },
  section: {
    marginBottom: theme.spacing.xl,
  },
  sectionTitle: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.primary,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: theme.spacing.sm,
  },
  sectionContent: {
    gap: theme.spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  rowPressed: {
    opacity: 0.8,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    flex: 1,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.sm,
    borderCurve: "continuous" as const,
    backgroundColor: theme.colors.secondary,
    alignItems: "center",
    justifyContent: "center",
  },
  rowIconDanger: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.sm,
    borderCurve: "continuous" as const,
    backgroundColor: "rgba(239, 68, 68, 0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 14,
    color: theme.colors.foreground,
    flex: 1,
  },
  rowLabelDanger: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 14,
    color: theme.colors.destructive,
    flex: 1,
  },
  rowValue: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 13,
    color: theme.colors.mutedForeground,
    maxWidth: "54%",
    textAlign: "right",
  },
  emptyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  emptyText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 13,
    color: theme.colors.mutedForeground,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingVertical: theme.spacing.md,
  },
  actionButtonText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 14,
    color: theme.colors.primary,
  },
  themeRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  themeOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    paddingVertical: 10,
  },
  themeOptionActive: {
    backgroundColor: theme.colors.primary,
  },
  themeOptionInactive: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  themeOptionText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
  },
  themeOptionTextActive: {
    color: theme.colors.primaryForeground,
  },
  themeOptionTextInactive: {
    color: theme.colors.foreground,
  },
  profileCard: {
    borderRadius: theme.radius.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.lg,
  },
  profileText: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
}));
