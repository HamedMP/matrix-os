import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  TextInput,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { Image } from "expo-image";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useGateway } from "../_layout";
import {
  appRuntimeHref,
  getAppIconName,
  getGatewayAppUrlLabel,
  getAppSlug,
  getNativeAppRoute,
  mergeNativeAndRemoteApps,
  type MatrixAppEntry,
} from "@/lib/apps";
import { colors, fonts, radius, spacing } from "@/lib/theme";

function AppGlyph({ app, gatewayUrl }: { app: MatrixAppEntry; gatewayUrl?: string }) {
  const iconUrl = app.icon && gatewayUrl && app.icon.startsWith("/")
    ? `${gatewayUrl.replace(/\/+$/, "")}${app.icon}`
    : app.icon;

  if (iconUrl && /^https?:\/\//.test(iconUrl)) {
    return (
      <Image
        source={{ uri: iconUrl }}
        style={{ width: 34, height: 34, borderRadius: 8 }}
        contentFit="cover"
      />
    );
  }

  return (
    <Ionicons
      name={getAppIconName(app) as keyof typeof Ionicons.glyphMap}
      size={30}
      color={colors.light.primary}
    />
  );
}

function AppCard({ app, gatewayUrl }: { app: MatrixAppEntry; gatewayUrl?: string }) {
  const slug = getAppSlug(app);
  const nativeRoute = getNativeAppRoute(app);
  const runtimeLabel = useMemo(
    () => (gatewayUrl ? getGatewayAppUrlLabel(gatewayUrl, app) : slug),
    [app, gatewayUrl, slug],
  );

  return (
    <Link href={(nativeRoute ?? appRuntimeHref(slug)) as any} asChild>
      <Pressable
        onPress={() => {
          if (process.env.EXPO_OS === "ios") {
            Haptics.selectionAsync();
          }
        }}
        style={({ pressed }) => ({
          minHeight: 82,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.light.border,
          backgroundColor: colors.light.card,
          padding: spacing.md,
          gap: spacing.md,
          flexDirection: "row",
          alignItems: "center",
          opacity: pressed ? 0.82 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        })}
      >
        <View
          style={{
            width: 54,
            height: 54,
            borderRadius: 15,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.light.secondary,
          }}
        >
          <AppGlyph app={app} gatewayUrl={gatewayUrl} />
        </View>
        <View style={{ gap: 4, flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: fonts.sansSemiBold,
              fontSize: 16,
              color: colors.light.foreground,
            }}
          >
            {app.name}
          </Text>
          <Text
            numberOfLines={2}
            style={{
              fontFamily: fonts.sans,
              fontSize: 13,
              lineHeight: 18,
              color: colors.light.mutedForeground,
            }}
          >
            {app.description ?? app.category ?? "Matrix app"}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", justifyContent: "center", maxWidth: 88 }}>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              color: colors.light.mutedForeground,
            }}
          >
            {nativeRoute ? "Native" : app.category ?? "App"}
          </Text>
          {!nativeRoute && gatewayUrl ? (
            <Text
              selectable
              numberOfLines={1}
              style={{
                maxWidth: 88,
                fontFamily: fonts.mono,
                fontSize: 10,
                color: colors.light.mutedForeground,
              }}
            >
              {runtimeLabel}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Link>
  );
}

export default function AppsScreen() {
  const { client } = useGateway();
  const [apps, setApps] = useState<MatrixAppEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const fetchApps = useCallback(async () => {
    if (!client) {
      setApps(mergeNativeAndRemoteApps([]));
      setLoading(false);
      return;
    }

    try {
      const nextApps = await client.getApps();
      setApps(mergeNativeAndRemoteApps(nextApps));
    } catch (err) {
      console.warn("[mobile] failed to fetch apps", err instanceof Error ? err.message : String(err));
      setApps(mergeNativeAndRemoteApps([]));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  const filteredApps = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return apps;
    return apps.filter((app) => {
      const haystack = `${app.name} ${app.description ?? ""} ${app.category ?? ""}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [apps, query]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchApps();
    setRefreshing(false);
  }, [fetchApps]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<MatrixAppEntry>) => (
      <AppCard app={item} gatewayUrl={client?.httpUrl} />
    ),
    [client],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.light.background }}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.md }}>
        <View
          style={{
            minHeight: 44,
            borderRadius: radius.full,
            borderWidth: 1,
            borderColor: colors.light.border,
            backgroundColor: colors.light.card,
            paddingHorizontal: spacing.lg,
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
          }}
        >
          <Ionicons name="search" size={18} color={colors.light.mutedForeground} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search apps"
            placeholderTextColor={colors.light.mutedForeground}
            style={{
              flex: 1,
              fontFamily: fonts.sans,
              color: colors.light.foreground,
              fontSize: 15,
              paddingVertical: 10,
            }}
          />
          {query ? (
            <Pressable onPress={() => setQuery("")}>
              <Ionicons name="close-circle" size={18} color={colors.light.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.light.primary} />
        </View>
      ) : (
        <FlatList
          data={filteredApps}
          renderItem={renderItem}
          keyExtractor={(item) => getAppSlug(item)}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 112, gap: spacing.md }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.light.primary} />
          }
          ListEmptyComponent={
            <View style={{ alignItems: "center", paddingVertical: 72, paddingHorizontal: spacing.xl }}>
              <View
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 18,
                  borderCurve: "continuous",
                  backgroundColor: colors.light.card,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 1,
                  borderColor: colors.light.border,
                  marginBottom: spacing.lg,
                }}
              >
                <Ionicons name="apps-outline" size={36} color={colors.light.primary} />
              </View>
              <Text style={{ fontFamily: fonts.sansSemiBold, fontSize: 17, color: colors.light.foreground }}>
                {client ? "No apps found" : "Connecting to Matrix OS"}
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
                Apps returned by your VPS launcher at app.matrix-os.com show up here.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}
