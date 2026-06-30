import { memo, useCallback, useEffect, useMemo, useReducer } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  TextInput,
  Text,
  useWindowDimensions,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Image } from "expo-image";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useGateway } from "../_layout";
import {
  appRuntimeHref,
  getAppIconName,
  getAppSlug,
  getNativeAppRoute,
  mergeNativeAndRemoteApps,
  type MatrixAppEntry,
} from "@/lib/apps";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";
import { colors } from "@/lib/theme";

const H_PADDING = 16;

// Icon-tile palette pairs a background with a legible glyph colour so fallback
// (no shipped icon) tiles never wash out. Stable per app via a slug hash.
const L = colors.light;
const TILE_PALETTE: Array<{ bg: string; fg: string }> = [
  { bg: L.forest, fg: "#DCE6D2" },
  { bg: L.moss, fg: "#EFF3EC" },
  { bg: "#5F7A6B", fg: "#EAF0EC" },
  { bg: "#7C6F4E", fg: "#F4EFE2" },
  { bg: L.glow, fg: "#FBEFE4" },
];

function tileFor(slug: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) hash = (hash + slug.charCodeAt(i)) % TILE_PALETTE.length;
  return TILE_PALETTE[hash];
}

function resolveIconUrl(app: MatrixAppEntry, gatewayUrl?: string): string | undefined {
  const icon = app.icon;
  if (!icon) return undefined;
  const url = icon.startsWith("/") && gatewayUrl ? `${gatewayUrl.replace(/\/+$/, "")}${icon}` : icon;
  return /^https?:\/\//.test(url) ? url : undefined;
}

// Premium springboard tile: shipped icons fill the squircle edge-to-edge; apps
// with no icon fall back to a tinted tile + category glyph instead of a generic
// repeated image.
function AppTileGlyph({
  app,
  gatewayUrl,
  tile,
}: {
  app: MatrixAppEntry;
  gatewayUrl?: string;
  tile: { bg: string; fg: string };
}) {
  const iconUrl = resolveIconUrl(app, gatewayUrl);

  if (iconUrl) {
    return (
      <Image
        source={{ uri: iconUrl }}
        style={styles.tileImage}
        contentFit="cover"
        transition={120}
        cachePolicy="memory-disk"
      />
    );
  }

  return (
    <View style={styles.tileFallback(tile.bg)}>
      {/* Soft top highlight gives the tile a glossy, app-icon feel without a gradient dep. */}
      <View style={styles.tileGloss} pointerEvents="none" />
      <Ionicons name={getAppIconName(app) as keyof typeof Ionicons.glyphMap} size={30} color={tile.fg} />
    </View>
  );
}

// One springboard cell: squircle icon tile + label beneath, fixed width so rows
// stay aligned even on a partial final row.
const AppGridItem = memo(function AppGridItem({
  app,
  gatewayUrl,
  width,
  active,
  onOpen,
}: {
  app: MatrixAppEntry;
  gatewayUrl?: string;
  width: number;
  active: boolean;
  onOpen: (slug: string) => void;
}) {
  const slug = getAppSlug(app);
  const nativeRoute = getNativeAppRoute(app);
  const tile = tileFor(slug);

  return (
    <Link href={(nativeRoute ?? appRuntimeHref(slug)) as any} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${app.name}`}
        onPress={() => {
          onOpen(slug);
          if (process.env.EXPO_OS === "ios") Haptics.selectionAsync();
        }}
        style={({ pressed }) => [styles.cell(width), pressed && styles.cellPressed]}
      >
        <View style={styles.tile}>
          <AppTileGlyph app={app} gatewayUrl={gatewayUrl} tile={tile} />
          {active ? <View style={styles.activeDot} /> : null}
        </View>
        <Text numberOfLines={1} style={styles.cellLabel}>
          {app.name}
        </Text>
      </Pressable>
    </Link>
  );
});

// "Jump back in" — the last-opened app as a single tappable card.
function RecentRow({
  app,
  gatewayUrl,
  onOpen,
}: {
  app: MatrixAppEntry;
  gatewayUrl?: string;
  onOpen: (slug: string) => void;
}) {
  const slug = getAppSlug(app);
  const nativeRoute = getNativeAppRoute(app);
  const tile = tileFor(slug);

  return (
    <Link href={(nativeRoute ?? appRuntimeHref(slug)) as any} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Continue ${app.name}`}
        onPress={() => onOpen(slug)}
        style={({ pressed }) => [styles.recentRow, pressed && styles.recentRowPressed]}
      >
        <View style={styles.recentTile}>
          <AppTileGlyph app={app} gatewayUrl={gatewayUrl} tile={tile} />
        </View>
        <View style={styles.recentText}>
          <Text numberOfLines={1} style={styles.recentName}>
            {app.name}
          </Text>
          <Text numberOfLines={1} style={styles.recentMeta}>
            {app.category ?? "Tap to reopen"}
          </Text>
        </View>
        <View style={styles.recentChevron}>
          <Ionicons name="arrow-forward" size={16} color={L.accentInk} />
        </View>
      </Pressable>
    </Link>
  );
}

interface AppsState {
  apps: MatrixAppEntry[];
  refreshing: boolean;
  loading: boolean;
  query: string;
  lastActiveAppSlug: string | null;
}

type AppsAction =
  | { type: "appsLoaded"; apps: MatrixAppEntry[] }
  | { type: "refreshStart" }
  | { type: "refreshEnd" }
  | { type: "queryChanged"; query: string }
  | { type: "lastActiveAppSlugChanged"; slug: string | null };

const initialAppsState: AppsState = {
  apps: [],
  refreshing: false,
  loading: true,
  query: "",
  lastActiveAppSlug: null,
};

function appsReducer(state: AppsState, action: AppsAction): AppsState {
  switch (action.type) {
    case "appsLoaded":
      return { ...state, apps: action.apps, loading: false };
    case "refreshStart":
      return { ...state, refreshing: true };
    case "refreshEnd":
      return { ...state, refreshing: false };
    case "queryChanged":
      return { ...state, query: action.query };
    case "lastActiveAppSlugChanged":
      return { ...state, lastActiveAppSlug: action.slug };
    default:
      return state;
  }
}

export default function AppsScreen() {
  const { width } = useWindowDimensions();
  const { theme } = useUnistyles();
  const { client, connectionState } = useGateway();
  const [state, dispatch] = useReducer(appsReducer, initialAppsState);
  const { apps, refreshing, loading, query, lastActiveAppSlug } = state;
  const connected = connectionState === "connected";

  const columns = width >= 600 ? 6 : 4;
  const cellWidth = Math.floor((width - H_PADDING * 2) / columns);

  const fetchApps = useCallback(async () => {
    if (!client) {
      dispatch({ type: "appsLoaded", apps: mergeNativeAndRemoteApps([]) });
      return;
    }
    try {
      const nextApps = await client.getApps();
      dispatch({ type: "appsLoaded", apps: mergeNativeAndRemoteApps(nextApps) });
    } catch (err) {
      console.warn("[mobile] failed to fetch apps", err instanceof Error ? err.message : String(err));
      dispatch({ type: "appsLoaded", apps: mergeNativeAndRemoteApps([]) });
    }
  }, [client]);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  useEffect(() => {
    loadMobileShellState()
      .then((shellState) => dispatch({ type: "lastActiveAppSlugChanged", slug: shellState.lastActiveAppSlug }))
      .catch((err: unknown) => {
        console.warn("[mobile] failed to load app open state", err instanceof Error ? err.message : String(err));
      });
  }, []);

  const handleOpenApp = useCallback((slug: string) => {
    dispatch({ type: "lastActiveAppSlugChanged", slug });
    loadMobileShellState()
      .then((shellState) =>
        saveMobileShellState({
          ...shellState,
          mode: "app",
          lastActiveAppSlug: slug,
          updatedAt: new Date().toISOString(),
        }),
      )
      .catch((err: unknown) => {
        console.warn("[mobile] failed to save app open state", err instanceof Error ? err.message : String(err));
      });
  }, []);

  const filteredApps = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return apps;
    return apps.filter((app) => {
      const haystack = `${app.name} ${app.description ?? ""} ${app.category ?? ""}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [apps, query]);

  const lastActiveApp = useMemo(() => {
    if (!lastActiveAppSlug) return null;
    return apps.find((app) => getAppSlug(app) === lastActiveAppSlug) ?? null;
  }, [apps, lastActiveAppSlug]);

  const handleRefresh = useCallback(async () => {
    dispatch({ type: "refreshStart" });
    await fetchApps();
    dispatch({ type: "refreshEnd" });
  }, [fetchApps]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<MatrixAppEntry>) => (
      <AppGridItem
        app={item}
        gatewayUrl={client?.httpUrl}
        width={cellWidth}
        active={lastActiveAppSlug === getAppSlug(item)}
        onOpen={handleOpenApp}
      />
    ),
    [client, cellWidth, handleOpenApp, lastActiveAppSlug],
  );

  const refreshControl = useMemo(
    () => <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={theme.colors.accentInk} />,
    [refreshing, handleRefresh, theme.colors.accentInk],
  );

  const listHeader = useMemo(
    () => (
      <View style={styles.listHeader}>
        {query.trim() === "" && lastActiveApp ? (
          <View>
            <Text style={styles.sectionLabel}>Jump back in</Text>
            <RecentRow app={lastActiveApp} gatewayUrl={client?.httpUrl} onOpen={handleOpenApp} />
          </View>
        ) : null}
        <Text style={styles.sectionLabel}>{query.trim() === "" ? "All apps" : "Results"}</Text>
      </View>
    ),
    [query, lastActiveApp, client, handleOpenApp],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerTitleGroup}>
          <Text style={styles.headerTitle}>Apps</Text>
          <Text style={styles.headerSubtitle}>
            {apps.length} installed{connected ? "" : " · connecting…"}
          </Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Account" style={styles.avatar}>
          <Ionicons name="person" size={16} color="#DCE6D2" />
        </Pressable>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={17} color={theme.colors.inkDim} />
          <TextInput
            value={query}
            onChangeText={(text) => dispatch({ type: "queryChanged", query: text })}
            placeholder="Search apps"
            placeholderTextColor={theme.colors.inkDim}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.searchInput}
          />
          {query ? (
            <Pressable accessibilityLabel="Clear search" onPress={() => dispatch({ type: "queryChanged", query: "" })}>
              <Ionicons name="close-circle" size={18} color={theme.colors.inkDim} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.accentInk} />
        </View>
      ) : (
        <FlatList
          key={`grid-${columns}`}
          data={filteredApps}
          renderItem={renderItem}
          keyExtractor={(item) => getAppSlug(item)}
          numColumns={columns}
          ListHeaderComponent={listHeader}
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="apps-outline" size={30} color={theme.colors.accentInk} />
              </View>
              <Text style={styles.emptyTitle}>{client ? "No apps found" : "Connecting to Matrix OS"}</Text>
              <Text style={styles.emptyText}>Apps from your VPS launcher at app.matrix-os.com appear here.</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  screen: { flex: 1, backgroundColor: theme.colors.paper },
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: rt.insets.top + 10,
    paddingBottom: 14,
  },
  headerTitleGroup: { flex: 1, minWidth: 0, gap: 3 },
  headerTitle: {
    fontFamily: theme.fonts.sansBold,
    fontSize: 32,
    letterSpacing: -1,
    lineHeight: 36,
    color: theme.colors.ink,
  },
  headerSubtitle: { fontFamily: theme.fonts.mono, fontSize: 12, color: theme.colors.inkMuted },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.forest,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: theme.shadows.sm,
  },
  searchWrap: { paddingHorizontal: 20, paddingBottom: 4 },
  searchBar: {
    height: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.lineSoft,
    backgroundColor: theme.colors.field,
  },
  searchInput: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    color: theme.colors.ink,
    paddingVertical: 8,
  },
  listHeader: { gap: 2 },
  sectionLabel: {
    fontFamily: theme.fonts.monoBold,
    fontSize: 11,
    letterSpacing: 0.9,
    textTransform: "uppercase",
    color: theme.colors.inkDim,
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 10,
  },
  listContent: { paddingHorizontal: H_PADDING, paddingBottom: 130 },

  // Grid cell + squircle tile
  cell: (w: number) => ({
    width: w,
    alignItems: "center" as const,
    gap: 8,
    paddingVertical: 9,
  }),
  cellPressed: { opacity: 0.85, transform: [{ scale: 0.93 }] },
  tile: {
    width: 64,
    height: 64,
    borderRadius: 19,
    overflow: "hidden",
    backgroundColor: theme.colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.line,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: theme.shadows.card,
  },
  tileImage: { width: "100%", height: "100%" },
  tileFallback: (bg: string) => ({
    width: "100%" as const,
    height: "100%" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: bg,
  }),
  tileGloss: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "55%",
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  activeDot: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 9,
    height: 9,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.glow,
    borderWidth: 1.5,
    borderColor: theme.colors.panel,
  },
  cellLabel: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 12,
    lineHeight: 15,
    textAlign: "center",
    color: theme.colors.ink,
  },

  // "Jump back in" card
  recentRow: {
    marginHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 12,
    borderRadius: theme.radius.xl2,
    borderWidth: 1,
    borderColor: theme.colors.line,
    backgroundColor: theme.colors.panel,
    boxShadow: theme.shadows.card,
  },
  recentRowPressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  recentTile: {
    width: 52,
    height: 52,
    borderRadius: 15,
    overflow: "hidden",
    backgroundColor: theme.colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  recentText: { flex: 1, minWidth: 0, gap: 3 },
  recentName: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 16,
    letterSpacing: -0.2,
    color: theme.colors.ink,
  },
  recentMeta: { fontFamily: theme.fonts.mono, fontSize: 11, color: theme.colors.inkMuted },
  recentChevron: {
    width: 30,
    height: 30,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.field,
    alignItems: "center",
    justifyContent: "center",
  },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", paddingVertical: 64, paddingHorizontal: 28 },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: theme.radius.xl2,
    backgroundColor: theme.colors.panel,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.line,
    marginBottom: 16,
    boxShadow: theme.shadows.card,
  },
  emptyTitle: { fontFamily: theme.fonts.sansSemiBold, fontSize: 17, color: theme.colors.ink },
  emptyText: {
    marginTop: 8,
    textAlign: "center",
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.inkMuted,
  },
}));
