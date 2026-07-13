import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import AppRuntimeFrame from "@/components/AppRuntimeFrame";
import { WindowHeader, WindowHeaderAction } from "@/components/WindowHeader";
import { useGateway } from "../_layout";
import { getAppSlug, getRuntimeSlug, slugFromParam, type MatrixAppEntry } from "@/lib/apps";
import { resolveMobileAppSessionLaunchUrl } from "@/lib/storage";

const SESSION_REFRESH_SKEW_MS = 60_000;
const SESSION_REFRESH_MIN_INTERVAL_MS = 30_000;
const MAX_SHORT_SESSION_REFRESHES = 3;

type RuntimeState = {
  app: MatrixAppEntry | null;
  launchUrl: string | null;
  loading: boolean;
  sessionReady: boolean;
  sessionExpiresAt: number | null;
};

type RuntimeAction =
  | { type: "reset" }
  | { type: "loadStart" }
  | { type: "appLoaded"; app: MatrixAppEntry | null }
  | { type: "sessionReady"; launchUrl: string; sessionExpiresAt: number }
  | { type: "loadEnd" };

const initialRuntimeState: RuntimeState = {
  app: null,
  launchUrl: null,
  loading: true,
  sessionReady: false,
  sessionExpiresAt: null,
};

function runtimeReducer(state: RuntimeState, action: RuntimeAction): RuntimeState {
  switch (action.type) {
    case "reset":
      return { ...initialRuntimeState, app: null, loading: false };
    case "loadStart":
      return { ...state, loading: true, sessionReady: false, launchUrl: null, sessionExpiresAt: null };
    case "appLoaded":
      return { ...state, app: action.app };
    case "sessionReady":
      return {
        ...state,
        launchUrl: action.launchUrl,
        sessionExpiresAt: action.sessionExpiresAt,
        sessionReady: true,
      };
    case "loadEnd":
      return { ...state, loading: false };
    default:
      return state;
  }
}

export default function RuntimeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const slug = slugFromParam(params.slug);
  const { client } = useGateway();
  const [state, dispatch] = useReducer(runtimeReducer, initialRuntimeState);
  const [maximized, setMaximized] = useState(false);
  const { app, launchUrl, loading, sessionReady, sessionExpiresAt } = state;
  const shortSessionRefreshCountRef = useRef(0);

  const fetchApp = useCallback(async () => {
    if (!client || !slug) {
      dispatch({ type: "reset" });
      return;
    }

    dispatch({ type: "loadStart" });
    try {
      const apps = await client.getApps();
      const nextApp = apps.find((entry) => getAppSlug(entry) === slug || getRuntimeSlug(entry) === slug) ?? null;
      dispatch({ type: "appLoaded", app: nextApp });
      if (nextApp) {
        const session = await client.createAppSessionToken(getRuntimeSlug(nextApp));
        if (session) {
          const resolvedUrl = resolveMobileAppSessionLaunchUrl(client.httpUrl, session.launchUrl);
          dispatch({ type: "sessionReady", launchUrl: resolvedUrl, sessionExpiresAt: session.expiresAt });
        }
      }
    } catch (err) {
      console.warn("[mobile] failed to load runtime app", err instanceof Error ? err.message : String(err));
    } finally {
      dispatch({ type: "loadEnd" });
    }
  }, [client, slug]);

  useEffect(() => {
    fetchApp();
  }, [fetchApp]);

  const onRefresh = useEffectEvent(() => {
    fetchApp();
  });

  useEffect(() => {
    if (!sessionReady || !sessionExpiresAt) return;
    const refreshInMsBeforeFloor = sessionExpiresAt - Date.now() - SESSION_REFRESH_SKEW_MS;
    const usesFloor = refreshInMsBeforeFloor < SESSION_REFRESH_MIN_INTERVAL_MS;
    if (usesFloor && shortSessionRefreshCountRef.current >= MAX_SHORT_SESSION_REFRESHES) {
      console.warn("[mobile] app session refresh paused after repeated short-lived tokens");
      return;
    }

    if (!usesFloor) {
      shortSessionRefreshCountRef.current = 0;
    }

    const refreshInMs = Math.max(SESSION_REFRESH_MIN_INTERVAL_MS, refreshInMsBeforeFloor);
    const timer = setTimeout(() => {
      if (usesFloor) {
        shortSessionRefreshCountRef.current += 1;
      }
      onRefresh();
    }, refreshInMs);
    return () => clearTimeout(timer);
  }, [sessionExpiresAt, sessionReady]);

  const appUrl = sessionReady ? launchUrl : null;
  const title = app?.name ?? slug;
  const goHome = useCallback(() => {
    router.dismissTo("/(tabs)/apps" as any);
  }, [router]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Stack.Screen options={{ headerShown: false }} />
      <WindowHeader
        paddingTop={insets.top + 8}
        title={title}
        subtitle={app?.category ?? "Matrix app"}
        subtitleMono={false}
        onBack={goHome}
        backIcon="home-outline"
        backLabel="Home"
        maximized={maximized}
        onToggleMaximized={() => setMaximized((prev) => !prev)}
        actions={
          <WindowHeaderAction
            icon="information-circle-outline"
            label="App info"
            onPress={() => router.push({ pathname: "/apps/[...slug]", params: { slug: slug.split("/") } } as any)}
          />
        }
      />
      <View style={{ flex: 1 }}>
        {loading ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : appUrl ? (
          <AppRuntimeFrame
            url={appUrl}
            title={title}
          />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing.xl }}>
            <View style={styles.warningIconBox}>
              <Ionicons name="warning-outline" size={34} color={theme.colors.primary} />
            </View>
            <Text style={{ fontFamily: theme.fonts.sansSemiBold, fontSize: 17, color: theme.colors.foreground }}>
              {app ? "App session unavailable" : "App unavailable"}
            </Text>
            <Text
              style={{
                marginTop: theme.spacing.sm,
                fontFamily: theme.fonts.sans,
                fontSize: 14,
                lineHeight: 20,
                color: theme.colors.mutedForeground,
                textAlign: "center",
              }}
            >
              Sign in and reconnect to Matrix OS, then try opening the app again.
            </Text>
            <Pressable
              onPress={fetchApp}
              style={({ pressed }) => ({
                marginTop: theme.spacing.lg,
                borderRadius: theme.radius.lg,
                borderCurve: "continuous",
                backgroundColor: theme.colors.primary,
                paddingHorizontal: theme.spacing.xl,
                paddingVertical: theme.spacing.md,
                opacity: pressed ? 0.82 : 1,
              })}
            >
              <Text style={{ fontFamily: theme.fonts.sansSemiBold, color: theme.colors.primaryForeground }}>
                Retry
              </Text>
            </Pressable>
            <Pressable
              onPress={goHome}
              style={({ pressed }) => ({
                marginTop: theme.spacing.sm,
                borderRadius: theme.radius.lg,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.card,
                paddingHorizontal: theme.spacing.xl,
                paddingVertical: theme.spacing.md,
                opacity: pressed ? 0.82 : 1,
              })}
            >
              <Text style={{ fontFamily: theme.fonts.sansSemiBold, color: theme.colors.foreground }}>
                Apps
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  warningIconBox: {
    width: 72,
    height: 72,
    borderRadius: 18,
    borderCurve: "continuous",
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.lg,
  },
}));
