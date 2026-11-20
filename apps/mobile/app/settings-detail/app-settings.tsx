import { useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import FingerPrintIcon from "@hugeicons/core-free-icons/FingerPrintIcon";
import Notification02Icon from "@hugeicons/core-free-icons/Notification02Icon";
import PaintBrush01Icon from "@hugeicons/core-free-icons/PaintBrush01Icon";

import {
  SettingsCardStack,
  SettingsPage,
  SettingsRow,
  SettingsSwitchRow,
} from "@/components/settings/SettingsSurface";
import { Divider, Icon, IconButton, Sheet, Spacer } from "@/components/ui";
import {
  authenticateBiometricNow,
  getBiometricLabel,
  getSupportedBiometricTypes,
  isBiometricAvailable,
} from "@/lib/auth";
import { getSettings, saveSettings, type AppSettings } from "@/lib/storage";
import { applyMobileThemePreference, type MobileThemePreference } from "@/lib/theme-preference";

const THEME_LABELS: Record<MobileThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export default function AppSettingsScreen() {
  const router = useRouter();
  const { theme: uiTheme } = useUnistyles();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [biometricLabel, setBiometricLabel] = useState("Biometric lock");
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [themeSheetVisible, setThemeSheetVisible] = useState(false);
  // The value a switch was just turned to, shown until the change settles.
  const [biometricTarget, setBiometricTarget] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getSettings(),
      isBiometricAvailable(),
      getSupportedBiometricTypes(),
    ]).then(([storedSettings, available, types]) => {
      if (!active) return;
      setSettings(storedSettings);
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
          <SettingsSwitchRow
            card
            title={biometricLabel}
            detail={biometricAvailable ? "Require authentication when Matrix OS opens" : "Not available on this device"}
            icon={FingerPrintIcon}
            disabled={!biometricAvailable || biometricTarget !== null}
            value={biometricTarget ?? settings.biometricEnabled}
            onValueChange={(enabled) => void changeBiometric(enabled)}
          />
          <SettingsRow
            card
            title="Push notifications"
            detail="Device permission and notification preferences"
            icon={Notification02Icon}
            onPress={() => router.push("/settings-detail/notifications" as never)}
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
                  <Icon icon={CheckmarkCircle02Icon} size={22} color={uiTheme.v2.colors.textDefault} />
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
    if (biometricTarget !== null) return;
    setBiometricTarget(enabled);
    try {
      if (enabled && !(await authenticateBiometricNow())) return;
      await saveSettings({ biometricEnabled: enabled });
      setSettings((current) => current ? { ...current, biometricEnabled: enabled } : current);
    } catch (error: unknown) {
      console.warn("[mobile] biometric setting failed", error instanceof Error ? error.name : "unknown");
      Alert.alert("Couldn’t update biometric lock", "Try again in a moment.");
    } finally {
      setBiometricTarget(null);
    }
  }
}

const styles = StyleSheet.create((theme) => ({
  status: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    color: theme.v2.appColors.muted,
  },
  sheetHeader: {
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  sheetTitle: {
    flex: 1,
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 18,
    color: theme.v2.appColors.ink,
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
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 18,
    color: theme.v2.appColors.ink,
  },
  pressed: {
    opacity: 0.65,
  },
}));
