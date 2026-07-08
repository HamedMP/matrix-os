import { useCallback, useMemo } from "react";
import { ActivityIndicator, Linking, Text, View } from "react-native";
import WebView from "react-native-webview";

import { colors, fonts, spacing } from "@/lib/theme";

interface AppRuntimeFrameProps {
  url: string;
  title: string;
  headers?: Record<string, string>;
  canOpenExternalUrl?: (url: string) => boolean;
}

export default function AppRuntimeFrame({ url, title, headers, canOpenExternalUrl }: AppRuntimeFrameProps) {
  const runtimeOrigin = useMemo(() => {
    try {
      return new URL(url).origin;
    } catch {
      return "https://app.matrix-os.com";
    }
  }, [url]);

  const shouldStartLoad = useCallback(
    (request: { url?: string }) => {
      if (!request.url || request.url === "about:blank") return true;
      try {
        const target = new URL(request.url);
        if (target.origin === runtimeOrigin) return true;
      } catch {
        return false;
      }
      if (canOpenExternalUrl && !canOpenExternalUrl(request.url)) return false;
      void Linking.openURL(request.url).catch((err: unknown) => {
        console.warn("[mobile] failed to open external app link", err instanceof Error ? err.message : String(err));
      });
      return false;
    },
    [canOpenExternalUrl, runtimeOrigin],
  );

  return (
    <WebView
      source={{ uri: url, headers }}
      originWhitelist={[runtimeOrigin, "about:*"]}
      onShouldStartLoadWithRequest={shouldStartLoad}
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
      renderError={() => (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: spacing.xl,
            backgroundColor: colors.light.background,
          }}
        >
          <Text style={{ fontFamily: fonts.sansSemiBold, fontSize: 17, color: colors.light.foreground }}>
            {title} could not load
          </Text>
          <Text
            style={{
              marginTop: spacing.sm,
              fontFamily: fonts.sans,
              fontSize: 14,
              lineHeight: 20,
              color: colors.light.mutedForeground,
              textAlign: "center",
            }}
          >
            Check your Matrix OS connection and try opening the app again.
          </Text>
        </View>
      )}
      allowsBackForwardNavigationGestures
      allowsInlineMediaPlayback
      javaScriptEnabled
      domStorageEnabled
      pullToRefreshEnabled
      setSupportMultipleWindows={false}
    />
  );
}
