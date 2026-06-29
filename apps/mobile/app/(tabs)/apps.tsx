import { memo, useCallback, useEffect, useMemo, useReducer } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  Text,
  useWindowDimensions,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { colors, fonts, radius } from "@/lib/theme";

const L = colors.light;
const H_PADDING = 14;

// Icon-tile palette pairs a background with a legible glyph colour so icons
// never wash out on pale tiles. Stable per app via a slug hash.
const TILE_PALETTE: Array<{ bg: string; fg: string }> = [
  { bg: L.forest, fg: "#DCE6D2" },
  { bg: L.moss, fg: "#EFF3EC" },
  { bg: "#5F7A6B", fg: "#EAF0EC" },
  { bg: L.lichen, fg: "#26301F" },
  { bg: L.glow, fg: "#FBEFE4" },
];

function tileFor(slug: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) hash = (hash + slug.charCodeAt(i)) % TILE_PALETTE.length;
  return TILE_PALETTE[hash];
}

function AppGlyph({ app, gatewayUrl, fg, size }: { app: MatrixAppEntry; gatewayUrl?: string; fg: string; size: number }) {
  const iconUrl = app.icon && gatewayUrl && app.icon.startsWith("/")
    ? `${gatewayUrl.replace(/\/+$/, "")}${app.icon}`
    : app.icon;

  if (iconUrl && /^https?:\/\//.test(iconUrl)) {
    return <Image source={{ uri: iconUrl }} style={[styles.glyphImage, { width: size, height: size }]} contentFit="cover" />;
  }
  return <Ionicons name={getAppIconName(app) as keyof typeof Ionicons.glyphMap} size={size} color={fg} />;
}

// One springboard cell: rounded icon tile + label beneath, fixed width so rows
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
        style={({ pressed }) => [styles.cell, { width }, pressed && styles.cellPressed]}
      >
        <View style={[styles.tile, { backgroundColor: tile.bg }]}>
          <AppGlyph app={app} gatewayUrl={gatewayUrl} fg={tile.fg} size={28} />
          {active ? <View style={styles.activeDot} /> : null}
        </View>
        <Text numberOfLines={1} style={styles.cellLabel}>{app.name}</Text>
      </Pressable>
    </Link>
  );
});

// "Jump back in" — the last-opened app as a single tappable row.
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
        style={({ pressed }) => [styles.recentRow, pressed && styles.cellPressed]}
      >
        <View style={[styles.recentTile, { backgroundColor: tile.bg }]}>
          <AppGlyph app={app} gatewayUrl={gatewayUrl} fg={tile.fg} size={26} />
        </View>
        <View style={styles.recentText}>
          <Text numberOfLines={1} style={styles.recentName}>{app.name}</Text>
          <Text numberOfLines={1} style={styles.recentMeta}>{app.category ?? "tap to reopen"}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={L.inkDim} />
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
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
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
      .then((shellState) => saveMobileShellState({
        ...shellState,
        mode: "app",
        lastActiveAppSlug: slug,
        updatedAt: new Date().toISOString(),
      }))
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
    () => <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={L.accentInk} />,
    [refreshing, handleRefresh],
  );

  const listHeader = useMemo(
    () => (
      <View>
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
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerTitleGroup}>
          <Text style={styles.headerTitle}>Apps</Text>
          <Text style={styles.headerSubtitle}>
            {apps.length} installed{connected ? "" : " · connecting…"}
          </Text>
        </View>
        <View style={styles.avatar}>
          <Ionicons name="person" size={15} color="#DCE6D2" />
        </View>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={17} color={L.inkDim} />
          <TextInput
            value={query}
            onChangeText={(text) => dispatch({ type: "queryChanged", query: text })}
            placeholder="Search apps"
            placeholderTextColor={L.inkDim}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.searchInput}
          />
          {query ? (
            <Pressable accessibilityLabel="Clear search" onPress={() => dispatch({ type: "queryChanged", query: "" })}>
              <Ionicons name="close-circle" size={17} color={L.inkDim} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={L.accentInk} />
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
                <Ionicons name="apps-outline" size={30} color={L.accentInk} />
              </View>
              <Text style={styles.emptyTitle}>{client ? "No apps found" : "Connecting to Matrix OS"}</Text>
              <Text style={styles.emptyText}>
                Apps from your VPS launcher at app.matrix-os.com appear here.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: L.paper },
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 12,
  },
  headerTitleGroup: { flex: 1, minWidth: 0, gap: 2 },
  headerTitle: { fontFamily: fonts.sansBold, fontSize: 30, letterSpacing: -0.9, lineHeight: 34, color: L.ink },
  headerSubtitle: { fontFamily: fonts.mono, fontSize: 12, color: L.inkMuted },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: L.forest,
    borderWidth: 1,
    borderColor: L.line,
    alignItems: "center",
    justifyContent: "center",
  },
  searchWrap: { paddingHorizontal: 18, paddingBottom: 6 },
  searchBar: {
    height: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: L.line,
    backgroundColor: L.field,
  },
  searchInput: { flex: 1, fontFamily: fonts.sans, fontSize: 14, color: L.ink, paddingVertical: 8 },
  sectionLabel: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 12,
    color: L.inkMuted,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
  },
  listContent: { paddingHorizontal: H_PADDING, paddingBottom: 120 },
  cell: {
    alignItems: "center",
    gap: 7,
    paddingVertical: 10,
  },
  cellPressed: { opacity: 0.75 },
  tile: {
    width: 60,
    height: 60,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  activeDot: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: "#DCE6D2",
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.18)",
  },
  glyphImage: { borderRadius: 14 },
  cellLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    lineHeight: 15,
    textAlign: "center",
    color: L.ink,
  },
  recentRow: {
    marginHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    padding: 12,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: L.line,
    backgroundColor: L.panel,
  },
  recentTile: {
    width: 46,
    height: 46,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  recentText: { flex: 1, minWidth: 0, gap: 2 },
  recentName: { fontFamily: fonts.sansSemiBold, fontSize: 16, letterSpacing: -0.2, color: L.ink },
  recentMeta: { fontFamily: fonts.mono, fontSize: 11, color: L.inkMuted },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", paddingVertical: 64, paddingHorizontal: 28 },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 18,
    backgroundColor: L.panel,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: L.line,
    marginBottom: 16,
  },
  emptyTitle: { fontFamily: fonts.sansSemiBold, fontSize: 17, color: L.ink },
  emptyText: {
    marginTop: 8,
    textAlign: "center",
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: L.inkMuted,
  },
});
