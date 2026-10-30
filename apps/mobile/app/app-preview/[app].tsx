import { ActivityIndicator, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import type { AppRepairDiagnostic } from "@matrix-os/contracts";

import AppRuntimeFrame from "@/components/AppRuntimeFrame";
import { useComputerAppSession } from "@/lib/queries/use-computer-apps";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { MatrixErrorRecovery } from "@/components/MatrixErrorRecovery";

export default function AppPreviewScreen() {
  const params = useLocalSearchParams<{
    app?: string | string[];
    runtimeSlug?: string | string[];
    name?: string | string[];
  }>();
  const app = Array.isArray(params.app) ? params.app[0] : params.app;
  const name = Array.isArray(params.name) ? params.name[0] : params.name;
  const runtimeSlugHint = Array.isArray(params.runtimeSlug) ? params.runtimeSlug[0] : params.runtimeSlug;
  const title = name || app || "App";
  const { launchUrl, isPending, isError, requestAppBridge, repairApp, retrySession, appIdentity, runtimeSlug } = useComputerAppSession(app ?? "", runtimeSlugHint);
  const { selectChat } = useCanonicalChatSession();
  const router = useRouter();
  const openRepair = useCallback(async (boundApp: string, diagnostic: AppRepairDiagnostic, signal?: AbortSignal) => {
    const result = await repairApp(boundApp, diagnostic, signal);
    selectChat(result.chatId);
    router.push("/(drawer)/(tabs)/(chats)");
    return result;
  }, [repairApp, selectChat, router]);
  const { theme } = useUnistyles();

  return (
    <View testID="app-preview-runtime" style={styles.screen}>
      <Stack.Screen options={{ title }} />
      {isPending ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.v2.appColors.ink} />
        </View>
      ) : launchUrl ? (
        <AppRuntimeFrame url={launchUrl} title={title} app={appIdentity} runtimeSlug={runtimeSlug} requestAppBridge={requestAppBridge} repairApp={openRepair} />
      ) : (
        <MatrixErrorRecovery title={isError ? "App session unavailable" : "App unavailable"}
          details="The app session could not start on this Matrix computer."
          onRetry={retrySession}
          onRepair={() => openRepair("Matrix OS", { operation: "app session", message: "App session could not start" })} />
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
