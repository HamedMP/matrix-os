import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import FingerPrintIcon from "@hugeicons/core-free-icons/FingerPrintIcon";
import Notification02Icon from "@hugeicons/core-free-icons/Notification02Icon";
import PaintBrush01Icon from "@hugeicons/core-free-icons/PaintBrush01Icon";

import { mockColors, mockFonts } from "@/components/mock-shell/theme";
import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Divider, Icon, IconButton, Sheet, Spacer } from "@/components/ui";
import {
  authenticateBiometricNow,
  getBiometricLabel,
  getSupportedBiometricTypes,
  isBiometricAvailable,
} from "@/lib/auth";
import {
  disablePushNotifications,
  enablePushNotifications,
  isPushNotificationsEnabled,
} from "@/lib/push";
import { fetchActiveComputer, mobileQueryKeys } from "@/lib/requests";
import { getSettings, HOSTED_GATEWAY_URL, saveSettings, type AppSettings } from "@/lib/storage";
import { applyMobileThemePreference, type MobileThemePreference } from "@/lib/theme-preference";

const THEME_LABELS: Record<MobileThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export default function AppSettingsScreen() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const authEnabled = Boolean(isLoaded && isSignedIn && userId);
  const activeComputer = useQuery({
    queryKey: mobileQueryKeys.activeComputer(userId ?? "signed-out"),
    enabled: authEnabled,
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Computer unavailable.");
      return fetchActiveComputer(token);
    },
  });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [biometricLabel, setBiometricLabel] = useState("Biometric lock");
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [themeSheetVisible, setThemeSheetVisible] = useState(false);
  const [changingBiometric, setChangingBiometric] = useState(false);
  const [changingPush, setChangingPush] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getSettings(),
      isBiometricAvailable(),
      getSupportedBiometricTypes(),
      isPushNotificationsEnabled(),
    ]).then(([storedSettings, available, types, pushEnabled]) => {
      if (!active) return;
      setSettings({ ...storedSettings, notificationsEnabled: pushEnabled });
      setBiometricAvailable(available);
      setBiometricLabel(available ? `${getBiometricLabel(types)} lock` : "Biometric lock");
    }).catch((error: unknown) => {
      console.warn("[mobile] app settings unavailable", error instanceof Error ? error.name : "unknown");
      if (active) {
        setSettings({ biometricEnabled: false, theme: "system", notificationsEnabled: false });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (!settings) {
    return (
      <SettingsPage>
        <Text style={styles.status}>Loading app settings…</Text>
      </SettingsPage>
    );
  }

  return (
    <>
      <SettingsPage>
        <SettingsCardStack>
          <SettingsRow
            card
            title="Theme"
            detail={THEME_LABELS[settings.theme]}
            icon={PaintBrush01Icon}
            onPress={() => setThemeSheetVisible(true)}
          />
          <SettingsRow
            card
            title={biometricLabel}
            detail={biometricAvailable ? "Require authentication when Matrix OS opens" : "Not available on this device"}
            icon={FingerPrintIcon}
            trailing={(
              <Switch
                accessibilityLabel={biometricLabel}
                disabled={!biometricAvailable || changingBiometric}
                value={settings.biometricEnabled}
                onValueChange={(enabled) => void changeBiometric(enabled)}
                trackColor={{ false: mockColors.line, true: mockColors.green }}
                thumbColor={mockColors.surface}
              />
            )}
          />
          <SettingsRow
            card
            title="Push notifications"
            detail={activeComputer.data ? "Notifications from this computer" : "Connect a computer to enable"}
            icon={Notification02Icon}
            trailing={(
              <Switch
                accessibilityLabel="Push notifications"
                disabled={!activeComputer.data || changingPush}
                value={settings.notificationsEnabled}
                onValueChange={(enabled) => void changePush(enabled)}
                trackColor={{ false: mockColors.line, true: mockColors.green }}
                thumbColor={mockColors.surface}
              />
            )}
          />
        </SettingsCardStack>
      </SettingsPage>

      <Sheet
        visible={themeSheetVisible}
        onClose={() => setThemeSheetVisible(false)}
        testID="theme-selection-sheet"
      >
        <Spacer />
        <View style={styles.sheetHeader}>
          <IconButton
            accessibilityLabel="Close theme options"
            icon={Cancel01Icon}
            iconSize={22}
            buttonSize={32}
            pressedOpacity={1}
            onPress={() => setThemeSheetVisible(false)}
          />
          <Text style={styles.sheetTitle}>Choose theme</Text>
          <View accessibilityElementsHidden style={styles.headerBalance} />
        </View>
        <Spacer size="xl" />
        <Divider />
        {(["light", "dark", "system"] as const).map((theme) => (
          <View key={theme}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Use ${THEME_LABELS[theme]} theme`}
              onPress={() => void changeTheme(theme)}
              style={({ pressed }) => [styles.themeOption, pressed ? styles.pressed : null]}
            >
              <Spacer size="lg" />
              <View style={styles.themeOptionContent}>
                <Text style={styles.themeOptionLabel}>{THEME_LABELS[theme]}</Text>
                {settings.theme === theme ? (
                  <Icon icon={CheckmarkCircle02Icon} size={22} color={mockColors.green} />
                ) : null}
              </View>
              <Spacer size="lg" />
            </Pressable>
            {theme !== "system" ? <Divider /> : null}
          </View>
        ))}
        <Spacer size="3xl" />
      </Sheet>
    </>
  );

  async function changeTheme(theme: MobileThemePreference) {
    try {
      await saveSettings({ theme });
      applyMobileThemePreference(theme);
      setSettings((current) => current ? { ...current, theme } : current);
      setThemeSheetVisible(false);
    } catch (error: unknown) {
      console.warn("[mobile] theme setting failed", error instanceof Error ? error.name : "unknown");
      Alert.alert("Couldn’t update the theme", "Try again in a moment.");
    }
  }

  async function changeBiometric(enabled: boolean) {
    if (changingBiometric) return;
    setChangingBiometric(true);
    try {
      if (enabled && !(await authenticateBiometricNow())) return;
      await saveSettings({ biometricEnabled: enabled });
      setSettings((current) => current ? { ...current, biometricEnabled: enabled } : current);
    } catch (error: unknown) {
      console.warn("[mobile] biometric setting failed", error instanceof Error ? error.name : "unknown");
      Alert.alert("Couldn’t update biometric lock", "Try again in a moment.");
    } finally {
      setChangingBiometric(false);
    }
  }

  async function changePush(enabled: boolean) {
    if (changingPush || !activeComputer.data) return;
    setChangingPush(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Authentication unavailable.");
      const gatewayUrl = `${HOSTED_GATEWAY_URL}${activeComputer.data.gatewayPath}`;
      if (enabled) {
        await enablePushNotifications({ clerkToken: token, gatewayUrl });
      } else {
        await disablePushNotifications({ clerkToken: token, gatewayUrl });
      }
      await saveSettings({ notificationsEnabled: enabled });
      setSettings((current) => current ? { ...current, notificationsEnabled: enabled } : current);
    } catch (error: unknown) {
      console.warn("[mobile] push setting failed", error instanceof Error ? error.name : "unknown");
      Alert.alert(
        enabled ? "Couldn’t enable notifications" : "Couldn’t disable notifications",
        "Check notification permissions and try again.",
      );
    } finally {
      setChangingPush(false);
    }
  }
}

const styles = StyleSheet.create({
  status: {
    fontFamily: mockFonts.body,
    fontSize: 14,
    color: mockColors.muted,
  },
  sheetHeader: {
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  sheetTitle: {
    flex: 1,
    fontFamily: mockFonts.semibold,
    fontSize: 18,
    color: mockColors.ink,
    textAlign: "center",
  },
  headerBalance: {
    width: 32,
    height: 32,
  },
  themeOption: {
    alignSelf: "stretch",
  },
  themeOptionContent: {
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  themeOptionLabel: {
    fontFamily: mockFonts.semibold,
    fontSize: 18,
    color: mockColors.ink,
  },
  pressed: {
    opacity: 0.65,
  },
});
