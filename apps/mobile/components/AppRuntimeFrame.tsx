import { ActivityIndicator, Text, View } from "react-native";
import WebView from "react-native-webview";

import { colors, fonts, spacing } from "@/lib/theme";

interface AppRuntimeFrameProps {
  url: string;
  title: string;
  headers?: Record<string, string>;
}

export default function AppRuntimeFrame({ url, title, headers }: AppRuntimeFrameProps) {
  return (
    <WebView
      source={{ uri: url, headers }}
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
