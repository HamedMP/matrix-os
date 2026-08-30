import { StyleSheet, Text, View } from "react-native";
import AppWindowIcon from "@hugeicons/core-free-icons/AppWindowIcon";
import { Stack, useLocalSearchParams } from "expo-router";

import { Icon } from "@/components/ui";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function AppPreviewScreen() {
  const params = useLocalSearchParams<{ app?: string | string[] }>();
  const app = Array.isArray(params.app) ? params.app[0] : params.app;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: app || "App" }} />
      <View style={styles.placeholder}>
        <View style={styles.icon}>
          <Icon icon={AppWindowIcon} size={32} color={mockColors.blue} />
        </View>
        <Text style={styles.title}>{app || "Matrix app"}</Text>
        <Text style={styles.subtitle}>Authenticated app WebView mock</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mockColors.surface },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  icon: {
    width: 68,
    height: 68,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    backgroundColor: mockColors.blueSoft,
  },
  title: { marginTop: 18, fontFamily: mockFonts.display, fontSize: 25, color: mockColors.ink },
  subtitle: { marginTop: 7, fontFamily: mockFonts.body, fontSize: 14, color: mockColors.muted },
});
