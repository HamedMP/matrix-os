import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import PuzzleIcon from "@hugeicons/core-free-icons/PuzzleIcon";
import { Stack, useLocalSearchParams } from "expo-router";

import { Icon, Spacer } from "@/components/ui";

export default function IntegrationDetailScreen() {
  const { theme } = useUnistyles();
  const params = useLocalSearchParams<{
    integration?: string | string[];
    name?: string | string[];
  }>();
  const integration = Array.isArray(params.integration) ? params.integration[0] : params.integration;
  const name = Array.isArray(params.name) ? params.name[0] : params.name;
  const displayName = name || integration || "integration";

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: displayName }} />
      <Spacer size="3xl" />
      <View style={styles.icon}>
        <Icon icon={PuzzleIcon} size={34} color={theme.v2.appColors.blue} />
      </View>
      <Spacer size="xl" />
      <Text style={styles.title}>Connect {displayName}</Text>
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

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.v2.appColors.canvas },
  content: { flexGrow: 1, alignItems: "center", paddingHorizontal: 24 },
  icon: { width: 72, height: 72, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: theme.v2.appColors.blueSoft },
  title: { fontFamily: theme.v2.fonts.display, fontSize: 26, color: theme.v2.appColors.ink },
  body: { maxWidth: 320, fontFamily: theme.v2.fonts.body, fontSize: 14, lineHeight: 21, textAlign: "center", color: theme.v2.appColors.muted },
  permissionCard: { alignSelf: "stretch", borderWidth: 1, borderColor: theme.v2.appColors.line, borderRadius: 18, paddingHorizontal: 17, backgroundColor: theme.v2.appColors.surface },
  permissionTitle: { fontFamily: theme.v2.fonts.semibold, fontSize: 14, color: theme.v2.appColors.ink },
  permission: { fontFamily: theme.v2.fonts.body, fontSize: 13, lineHeight: 19, color: theme.v2.appColors.muted },
  button: { alignSelf: "stretch", alignItems: "center", borderRadius: 16, backgroundColor: theme.v2.appColors.ink },
  buttonText: { fontFamily: theme.v2.fonts.semibold, fontSize: 15, color: theme.v2.appColors.surface },
}));
