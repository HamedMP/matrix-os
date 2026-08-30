import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams } from "expo-router";

import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function IntegrationDetailScreen() {
  const params = useLocalSearchParams<{ integration?: string | string[] }>();
  const integration = Array.isArray(params.integration) ? params.integration[0] : params.integration;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: integration || "Integration" }} />
      <View style={styles.icon}>
        <Ionicons name="extension-puzzle-outline" size={34} color={mockColors.blue} />
      </View>
      <Text style={styles.title}>Connect {integration || "integration"}</Text>
      <Text style={styles.body}>This mock will become the permission and account connection flow for this service.</Text>
      <View style={styles.permissionCard}>
        <Text style={styles.permissionTitle}>Matrix would be able to</Text>
        <Text style={styles.permission}>• Read selected workspace data</Text>
        <Text style={styles.permission}>• Act only when you ask</Text>
        <Text style={styles.permission}>• Store credentials on your Matrix computer</Text>
      </View>
      <Pressable accessibilityRole="button" style={styles.button}>
        <Text style={styles.buttonText}>Continue</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", padding: 24, paddingTop: 54, backgroundColor: mockColors.canvas },
  icon: { width: 72, height: 72, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: mockColors.blueSoft },
  title: { marginTop: 20, fontFamily: mockFonts.display, fontSize: 26, color: mockColors.ink },
  body: { maxWidth: 320, marginTop: 9, fontFamily: mockFonts.body, fontSize: 14, lineHeight: 21, textAlign: "center", color: mockColors.muted },
  permissionCard: { alignSelf: "stretch", gap: 9, marginTop: 30, borderWidth: 1, borderColor: mockColors.line, borderRadius: 18, padding: 17, backgroundColor: mockColors.surface },
  permissionTitle: { marginBottom: 3, fontFamily: mockFonts.semibold, fontSize: 14, color: mockColors.ink },
  permission: { fontFamily: mockFonts.body, fontSize: 13, lineHeight: 19, color: mockColors.muted },
  button: { alignSelf: "stretch", alignItems: "center", marginTop: 18, borderRadius: 16, paddingVertical: 15, backgroundColor: mockColors.ink },
  buttonText: { fontFamily: mockFonts.semibold, fontSize: 15, color: mockColors.surface },
});
