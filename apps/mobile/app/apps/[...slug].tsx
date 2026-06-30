import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useGateway } from "../_layout";
import {
  appRuntimeHref,
  buildGatewayAppUrl,
  getAppIconName,
  getAppSlug,
  getNativeAppRoute,
  getRuntimeSlug,
  slugFromParam,
  type MatrixAppEntry,
  type MatrixAppManifestResponse,
} from "@/lib/apps";

function PrimaryAction({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 50,
        borderRadius: theme.radius.xl,
        borderCurve: "continuous",
        backgroundColor: disabled ? theme.colors.muted : theme.colors.primary,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: theme.spacing.sm,
        opacity: pressed ? 0.82 : 1,
        transform: [{ scale: pressed ? 0.98 : 1 }],
      })}
    >
      <Ionicons
        name={icon}
        size={19}
        color={disabled ? theme.colors.mutedForeground : theme.colors.primaryForeground}
      />
      <Text
        style={{
          fontFamily: theme.fonts.sansSemiBold,
          fontSize: 16,
          color: disabled ? theme.colors.mutedForeground : theme.colors.primaryForeground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function MetadataRow({ label, value }: { label: string; value?: string | null }) {
  const { theme } = useUnistyles();
  if (!value) return null;
  return (
    <View
      style={{
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: theme.spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Text style={{ fontFamily: theme.fonts.sansMedium, fontSize: 14, color: theme.colors.mutedForeground }}>
        {label}
      </Text>
      <Text
        selectable
        numberOfLines={1}
        style={{ flex: 1, textAlign: "right", fontFamily: theme.fonts.sansMedium, fontSize: 14, color: theme.colors.foreground }}
      >
        {value}
      </Text>
    </View>
  );
}

export default function AppDetailScreen() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const slug = slugFromParam(params.slug);
  const { client } = useGateway();
  const [app, setApp] = useState<MatrixAppEntry | null>(null);
  const [manifest, setManifest] = useState<MatrixAppManifestResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const nativeRoute = app ? getNativeAppRoute(app) : null;
  const appUrl = useMemo(() => (client && app ? buildGatewayAppUrl(client.httpUrl, app) : null), [client, app]);

  const fetchApp = useCallback(async () => {
    if (!client || !slug) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const apps = await client.getApps();
      const nextApp = apps.find((entry) => getAppSlug(entry) === slug || getRuntimeSlug(entry) === slug) ?? null;
      const manifestData = nextApp ? await client.getAppManifest(getRuntimeSlug(nextApp)) : null;
      setApp(nextApp);
      setManifest(manifestData);
    } catch (err) {
      console.warn("[mobile] failed to load app detail", err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, slug]);

  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-derived-state -- "loading" is genuine async fetch-in-flight state (set true on request start, false in finally) that gates the rendered spinner; it has no synchronous source to derive from during render.
    fetchApp();
  }, [fetchApp]);

  const displayName = manifest?.manifest?.name ?? app?.name ?? slug;
  const description = manifest?.manifest?.description ?? app?.description;
  const iconUrl = app?.icon && client?.httpUrl && app.icon.startsWith("/")
    ? `${client.httpUrl.replace(/\/+$/, "")}${app.icon}`
    : app?.icon;

  const openNative = useCallback(() => {
    if (!nativeRoute) return;
    if (process.env.EXPO_OS === "ios") {
      Haptics.selectionAsync();
    }
    router.push(nativeRoute as any);
  }, [nativeRoute, router]);

  const openRuntime = useCallback(async () => {
    router.push(appRuntimeHref(slug) as any);
  }, [router, slug]);

  const copyUrl = useCallback(async () => {
    if (!appUrl) return;
    await Clipboard.setStringAsync(appUrl);
    Alert.alert("Copied", "App runtime URL copied.");
  }, [appUrl]);

  return (
    <>
      <Stack.Screen options={{ title: displayName }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 48, gap: theme.spacing.lg }}
      >
        {loading ? (
          <View style={{ minHeight: 240, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : (
          <>
            <View style={styles.heroCard}>
              <View style={{ flexDirection: "row", gap: theme.spacing.lg, alignItems: "center" }}>
                <View
                  style={{
                    width: 76,
                    height: 76,
                    borderRadius: 20,
                    borderCurve: "continuous",
                    backgroundColor: theme.colors.secondary,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {iconUrl && /^https?:\/\//.test(iconUrl) ? (
                    <Image
                      source={{ uri: iconUrl }}
                      style={{ width: 52, height: 52, borderRadius: 12 }}
                      contentFit="cover"
                    />
                  ) : (
                    <Ionicons
                      name={getAppIconName({ name: displayName, category: app?.category }) as keyof typeof Ionicons.glyphMap}
                      size={38}
                      color={theme.colors.primary}
                    />
                  )}
                </View>
                <View style={{ flex: 1, gap: theme.spacing.xs }}>
                  <Text style={{ fontFamily: theme.fonts.sansBold, fontSize: 24, color: theme.colors.foreground }}>
                    {displayName}
                  </Text>
                  <Text style={{ fontFamily: theme.fonts.sansMedium, fontSize: 14, color: theme.colors.mutedForeground }}>
                    {nativeRoute ? "Native mobile screen" : "Matrix runtime app"}
                  </Text>
                </View>
              </View>

              {description ? (
                <Text selectable style={{ fontFamily: theme.fonts.sans, fontSize: 15, lineHeight: 22, color: theme.colors.foreground }}>
                  {description}
                </Text>
              ) : null}

              {nativeRoute ? (
                <PrimaryAction icon="phone-portrait" label="Open Native Screen" onPress={openNative} />
              ) : (
                <PrimaryAction icon="phone-portrait-outline" label="Open App" onPress={openRuntime} disabled={!appUrl} />
              )}
            </View>

            <View
              style={{
                borderRadius: theme.radius.xl,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.card,
                paddingHorizontal: theme.spacing.lg,
              }}
            >
              <MetadataRow label="Slug" value={slug} />
              <MetadataRow label="Category" value={manifest?.manifest?.category ?? app?.category} />
              <MetadataRow label="Version" value={manifest?.manifest?.version ?? app?.version} />
              <MetadataRow label="Runtime" value={manifest?.manifest?.runtime} />
              <MetadataRow label="Runtime state" value={manifest?.runtimeState?.status} />
              <MetadataRow label="Distribution" value={manifest?.distributionStatus?.status} />
              <MetadataRow label="File" value={app?.file} />
            </View>

            {appUrl ? (
              <Pressable
                onPress={copyUrl}
                style={({ pressed }) => ({
                  minHeight: 46,
                  borderRadius: theme.radius.lg,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.card,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  gap: theme.spacing.sm,
                  opacity: pressed ? 0.82 : 1,
                })}
              >
                <Ionicons name="copy-outline" size={17} color={theme.colors.foreground} />
                <Text style={{ fontFamily: theme.fonts.sansSemiBold, fontSize: 14, color: theme.colors.foreground }}>
                  Copy Runtime URL
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  heroCard: {
    borderRadius: theme.radius.xl,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.xl,
    gap: theme.spacing.lg,
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.06)",
  },
}));
