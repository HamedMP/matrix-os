import { useCallback, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import WebView from "react-native-webview";

import { appRuntimeNavigation } from "@/lib/app-runtime-navigation";
import { colors, fonts, spacing } from "@/lib/theme";

interface AppRuntimeFrameProps {
  url: string;
  title: string;
  headers?: Record<string, string>;
  /** Host-reviewed web destinations only; this does not grant payment permission. */
  canOpenExternalUrl?: (url: string) => boolean;
}

export default function AppRuntimeFrame(props: AppRuntimeFrameProps) {
  // Android does not consult onShouldStartLoadWithRequest for the first load.
  if (appRuntimeNavigation(props.url, props.url) !== "internal") {
    return <AppRuntimeUnavailable title={props.title} />;
  }
  // A new launch session starts with a fresh notice and native WebView state.
  return <AppRuntimeFrameContent key={props.url} {...props} />;
}

function AppRuntimeFrameContent({ url, title, headers, canOpenExternalUrl }: AppRuntimeFrameProps) {
  const [linkBlocked, setLinkBlocked] = useState(false);

  const shouldStartLoad = useCallback(
    (request: { url?: string }) => {
      const decision = appRuntimeNavigation(url, request.url ?? "", canOpenExternalUrl);
      if (decision === "internal") {
        setLinkBlocked(false);
        return true;
      }
      if (decision === "external" && request.url) {
        void Linking.openURL(request.url).catch((error: unknown) => {
          console.warn("[mobile] external app link unavailable", error instanceof Error ? error.name : "UnknownError");
          setLinkBlocked(true);
        });
      } else {
        setLinkBlocked(true);
      }
      return false;
    },
    [canOpenExternalUrl, url],
  );

  return (
    <View style={{ flex: 1 }}>
      {linkBlocked && (
        <View style={{ padding: spacing.md, backgroundColor: colors.light.secondary }}>
          <Text accessibilityRole="alert" style={{ fontFamily: fonts.sans, color: colors.light.foreground }}>
            This link is unavailable in this app preview.
          </Text>
          <Pressable accessibilityRole="button" onPress={() => setLinkBlocked(false)} style={{ paddingVertical: spacing.sm }}>
            <Text style={{ fontFamily: fonts.sansSemiBold, color: colors.light.foreground }}>Continue in app</Text>
          </Pressable>
        </View>
      )}
      <WebView
        source={{ uri: url, headers }}
        // WebView opens non-whitelisted URLs through Linking before consulting
        // our callback. Route every scheme through the fail-closed policy instead.
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={shouldStartLoad}
        onOpenWindow={() => setLinkBlocked(true)}
        style={{ flex: 1, backgroundColor: colors.light.background }}
        containerStyle={{ flex: 1, backgroundColor: colors.light.background }}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        startInLoadingState
        renderLoading={() => (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.light.primary} />
          </View>
        )}
        renderError={() => <AppRuntimeUnavailable title={title} />}
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        javaScriptEnabled
        domStorageEnabled
        pullToRefreshEnabled
        // On Android, route target=_blank/window.open through onOpenWindow too.
        setSupportMultipleWindows
      />
    </View>
  );
}

function AppRuntimeUnavailable({ title }: { title: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, backgroundColor: colors.light.background }}>
      <Text style={{ fontFamily: fonts.sansSemiBold, fontSize: 17, color: colors.light.foreground }}>
        {title} could not load
      </Text>
      <Text style={{ marginTop: spacing.sm, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.light.mutedForeground, textAlign: "center" }}>
        Check your Matrix OS connection and try opening the app again.
      </Text>
    </View>
  );
}
