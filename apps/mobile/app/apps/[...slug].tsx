import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
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
  type MatrixAppEntry,
  type MatrixAppManifestResponse,
} from "@/lib/apps";
import { colors, fonts, radius, spacing } from "@/lib/theme";

function slugFromParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join("/");
  return value ?? "";
}

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
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 50,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        backgroundColor: disabled ? colors.light.muted : colors.light.primary,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: spacing.sm,
        opacity: pressed ? 0.82 : 1,
        transform: [{ scale: pressed ? 0.98 : 1 }],
      })}
    >
      <Ionicons
        name={icon}
        size={19}
        color={disabled ? colors.light.mutedForeground : colors.light.primaryForeground}
      />
      <Text
        style={{
          fontFamily: fonts.sansSemiBold,
          fontSize: 16,
          color: disabled ? colors.light.mutedForeground : colors.light.primaryForeground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function MetadataRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View
      style={{
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.light.border,
      }}
    >
      <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.light.mutedForeground }}>
        {label}
      </Text>
      <Text
        selectable
        numberOfLines={1}
        style={{ flex: 1, textAlign: "right", fontFamily: fonts.sansMedium, fontSize: 14, color: colors.light.foreground }}
      >
        {value}
      </Text>
    </View>
  );
}

export default function AppDetailScreen() {
  const router = useRouter();
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

    try {
      const [apps, manifestData] = await Promise.all([
        client.getApps(),
        client.getAppManifest(slug),
      ]);
      setApp(apps.find((entry) => getAppSlug(entry) === slug) ?? null);
      setManifest(manifestData);
    } catch (err) {
      console.warn("[mobile] failed to load app detail", err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, slug]);

  useEffect(() => {
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
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48, gap: spacing.lg }}
      >
        {loading ? (
          <View style={{ minHeight: 240, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.light.primary} />
          </View>
        ) : (
          <>
            <View
              style={{
                borderRadius: radius.xl,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: colors.light.border,
                backgroundColor: colors.light.card,
                padding: spacing.xl,
                gap: spacing.lg,
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.06)",
              }}
            >
              <View style={{ flexDirection: "row", gap: spacing.lg, alignItems: "center" }}>
                <View
                  style={{
                    width: 76,
                    height: 76,
                    borderRadius: 20,
                    borderCurve: "continuous",
                    backgroundColor: colors.light.secondary,
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
                      color={colors.light.primary}
                    />
                  )}
                </View>
                <View style={{ flex: 1, gap: spacing.xs }}>
                  <Text style={{ fontFamily: fonts.sansBold, fontSize: 24, color: colors.light.foreground }}>
                    {displayName}
                  </Text>
                  <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.light.mutedForeground }}>
                    {nativeRoute ? "Native mobile screen" : "Matrix runtime app"}
                  </Text>
                </View>
              </View>

              {description ? (
                <Text selectable style={{ fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, color: colors.light.foreground }}>
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
                borderRadius: radius.xl,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: colors.light.border,
                backgroundColor: colors.light.card,
                paddingHorizontal: spacing.lg,
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
                  borderRadius: radius.lg,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: colors.light.border,
                  backgroundColor: colors.light.card,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  gap: spacing.sm,
                  opacity: pressed ? 0.82 : 1,
                })}
              >
                <Ionicons name="copy-outline" size={17} color={colors.light.foreground} />
                <Text style={{ fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.light.foreground }}>
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
