import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Stack, useLocalSearchParams } from "expo-router";

import AppRuntimeFrame from "@/components/AppRuntimeFrame";
import { Spacer } from "@/components/ui";
import { useComputerAppSession } from "@/lib/queries/use-computer-apps";

export default function AppPreviewScreen() {
  const params = useLocalSearchParams<{
    app?: string | string[];
    name?: string | string[];
  }>();
  const app = Array.isArray(params.app) ? params.app[0] : params.app;
  const name = Array.isArray(params.name) ? params.name[0] : params.name;
  const title = name || app || "App";
  const { launchUrl, isPending, isError } = useComputerAppSession(app ?? "");
  const { theme } = useUnistyles();

  return (
    <View testID="app-preview-runtime" style={styles.screen}>
      <Stack.Screen options={{ title }} />
      {isPending ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.v2.appColors.ink} />
        </View>
      ) : launchUrl ? (
        <AppRuntimeFrame url={launchUrl} title={title} />
      ) : (
        <View style={styles.centered}>
          <Text style={styles.title}>{isError ? "App session unavailable" : "App unavailable"}</Text>
          <Spacer size="sm" />
          <Text style={styles.subtitle}>Close the app and try opening it again.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.v2.appColors.surface,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontFamily: theme.v2.fonts.display,
    fontSize: 20,
    color: theme.v2.appColors.ink,
  },
  subtitle: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    color: theme.v2.appColors.muted,
  },
}));
