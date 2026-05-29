import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import AppRuntimeFrame from "@/components/AppRuntimeFrame";
import { useGateway } from "../_layout";
import { getAppSlug, getRuntimeSlug, slugFromParam, type MatrixAppEntry } from "@/lib/apps";
import { colors, fonts, radius, spacing } from "@/lib/theme";

const SESSION_REFRESH_SKEW_MS = 60_000;
const SESSION_REFRESH_MIN_INTERVAL_MS = 30_000;
const MAX_SHORT_SESSION_REFRESHES = 3;

export default function RuntimeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const slug = slugFromParam(params.slug);
  const { client } = useGateway();
  const [app, setApp] = useState<MatrixAppEntry | null>(null);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const shortSessionRefreshCountRef = useRef(0);

  const fetchApp = useCallback(async () => {
    if (!client || !slug) {
      setApp(null);
      setLaunchUrl(null);
      setSessionReady(false);
      setSessionExpiresAt(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setSessionReady(false);
    setLaunchUrl(null);
    setSessionExpiresAt(null);
    try {
      const apps = await client.getApps();
      const nextApp = apps.find((entry) => getAppSlug(entry) === slug || getRuntimeSlug(entry) === slug) ?? null;
      setApp(nextApp);
      if (nextApp) {
        const session = await client.createAppSessionToken(getRuntimeSlug(nextApp));
        if (session) {
          const base = client.httpUrl.replace(/\/+$/, "");
          setLaunchUrl(
            session.launchUrl.startsWith("http")
              ? session.launchUrl
              : `${base}${session.launchUrl.startsWith("/") ? "" : "/"}${session.launchUrl}`,
          );
          setSessionExpiresAt(session.expiresAt);
          setSessionReady(true);
        }
      }
    } catch (err) {
      console.warn("[mobile] failed to load runtime app", err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, slug]);

  useEffect(() => {
    fetchApp();
  }, [fetchApp]);

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
      fetchApp();
    }, refreshInMs);
    return () => clearTimeout(timer);
  }, [fetchApp, sessionExpiresAt, sessionReady]);

  const appUrl = useMemo(
    () => (sessionReady ? launchUrl : null),
    [launchUrl, sessionReady],
  );
  const title = app?.name ?? slug;

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerLeft: () => (
            <Pressable
              onPress={() => router.replace("/(tabs)/apps" as any)}
              style={({ pressed }) => ({
                minWidth: 34,
                minHeight: 34,
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.65 : 1,
              })}
            >
              <Ionicons name="home-outline" size={22} color={colors.light.foreground} />
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={() => router.push({ pathname: "/apps/[...slug]", params: { slug: slug.split("/") } } as any)}
              style={({ pressed }) => ({
                minWidth: 34,
                minHeight: 34,
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.65 : 1,
              })}
            >
              <Ionicons name="information-circle-outline" size={22} color={colors.light.foreground} />
            </Pressable>
          ),
        }}
      />
      <View style={{ flex: 1, backgroundColor: colors.light.background }}>
        {loading ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.light.primary} />
          </View>
        ) : appUrl ? (
          <AppRuntimeFrame
            url={appUrl}
            title={title}
          />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl }}>
            <View
              style={{
                width: 72,
                height: 72,
                borderRadius: 18,
                borderCurve: "continuous",
                backgroundColor: colors.light.card,
                borderWidth: 1,
                borderColor: colors.light.border,
                alignItems: "center",
                justifyContent: "center",
                marginBottom: spacing.lg,
              }}
            >
              <Ionicons name="warning-outline" size={34} color={colors.light.primary} />
            </View>
            <Text style={{ fontFamily: fonts.sansSemiBold, fontSize: 17, color: colors.light.foreground }}>
              {app ? "App session unavailable" : "App unavailable"}
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
              Sign in and reconnect to Matrix OS, then try opening the app again.
            </Text>
            <Pressable
              onPress={fetchApp}
              style={({ pressed }) => ({
                marginTop: spacing.lg,
                borderRadius: radius.lg,
                borderCurve: "continuous",
                backgroundColor: colors.light.primary,
                paddingHorizontal: spacing.xl,
                paddingVertical: spacing.md,
                opacity: pressed ? 0.82 : 1,
              })}
            >
              <Text style={{ fontFamily: fonts.sansSemiBold, color: colors.light.primaryForeground }}>
                Retry
              </Text>
            </Pressable>
            <Pressable
              onPress={() => router.replace("/(tabs)/apps" as any)}
              style={({ pressed }) => ({
                marginTop: spacing.sm,
                borderRadius: radius.lg,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: colors.light.border,
                backgroundColor: colors.light.card,
                paddingHorizontal: spacing.xl,
                paddingVertical: spacing.md,
                opacity: pressed ? 0.82 : 1,
              })}
            >
              <Text style={{ fontFamily: fonts.sansSemiBold, color: colors.light.foreground }}>
                Apps
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </>
  );
}
