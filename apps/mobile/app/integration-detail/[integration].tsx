import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import PuzzleIcon from "@hugeicons/core-free-icons/PuzzleIcon";
import { Stack, useLocalSearchParams } from "expo-router";

import { Icon, Spacer } from "@/components/ui";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function IntegrationDetailScreen() {
  const params = useLocalSearchParams<{ integration?: string | string[] }>();
  const integration = Array.isArray(params.integration) ? params.integration[0] : params.integration;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: integration || "Integration" }} />
      <Spacer size="3xl" />
      <View style={styles.icon}>
        <Icon icon={PuzzleIcon} size={34} color={mockColors.blue} />
      </View>
      <Spacer size="xl" />
      <Text style={styles.title}>Connect {integration || "integration"}</Text>
      <Spacer size="sm" />
      <Text style={styles.body}>This mock will become the permission and account connection flow for this service.</Text>
      <Spacer size="2xl" />
      <View style={styles.permissionCard}>
        <Spacer size="lg" />
        <Text style={styles.permissionTitle}>Matrix would be able to</Text>
        <Spacer size="xs" />
        <Text style={styles.permission}>• Read selected workspace data</Text>
        <Spacer size="sm" />
        <Text style={styles.permission}>• Act only when you ask</Text>
        <Spacer size="sm" />
        <Text style={styles.permission}>• Store credentials on your Matrix computer</Text>
        <Spacer size="lg" />
      </View>
      <Spacer size="lg" />
      <Pressable accessibilityRole="button" style={styles.button}>
        <Spacer size="lg" />
        <Text style={styles.buttonText}>Continue</Text>
        <Spacer size="lg" />
      </Pressable>
      <Spacer size="3xl" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mockColors.canvas },
  content: { flexGrow: 1, alignItems: "center", paddingHorizontal: 24 },
  icon: { width: 72, height: 72, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: mockColors.blueSoft },
  title: { fontFamily: mockFonts.display, fontSize: 26, color: mockColors.ink },
  body: { maxWidth: 320, fontFamily: mockFonts.body, fontSize: 14, lineHeight: 21, textAlign: "center", color: mockColors.muted },
  permissionCard: { alignSelf: "stretch", borderWidth: 1, borderColor: mockColors.line, borderRadius: 18, paddingHorizontal: 17, backgroundColor: mockColors.surface },
  permissionTitle: { fontFamily: mockFonts.semibold, fontSize: 14, color: mockColors.ink },
  permission: { fontFamily: mockFonts.body, fontSize: 13, lineHeight: 19, color: mockColors.muted },
  button: { alignSelf: "stretch", alignItems: "center", borderRadius: 16, backgroundColor: mockColors.ink },
  buttonText: { fontFamily: mockFonts.semibold, fontSize: 15, color: mockColors.surface },
});
