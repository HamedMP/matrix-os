import { memo, useCallback, useEffect, useMemo, useReducer, useState } from "react";
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
  getAppSlug,
  getNativeAppRoute,
  mergeNativeAndRemoteApps,
  type MatrixAppEntry,
} from "@/lib/apps";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";
import { colors } from "@/lib/theme";

const H_PADDING = 16;

// Chat intentionally stays out of the launcher grid; the Apps launcher also
// hides itself because it is the current surface.
const HIDDEN_APP_SLUGS = new Set<string>(["apps", "chat"]);

// Fallback monogram-tile palette: tinted background + legible glyph colour,
// stable per app via a slug hash, used only when an icon image is unavailable.
const L = colors.light;
const TILE_PALETTE: { bg: string; fg: string }[] = [
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

const SAFE_ICON_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const APP_RASTER_ICON_SLUGS = new Set([
  "2048",
  "backgammon",
  "calculator",
  "chat",
  "chess",
  "clock",
  "code",
  "expense-tracker",
  "files",
  "game-center",
  "minesweeper",
  "notes",
  "pomodoro-timer",
  "profile",
  "snake",
  "social",
  "solitaire",
  "task-manager",
  "terminal",
  "tetris",
  "todo",
  "weather",
  "whiteboard",
  "workspace",
]);

const SHIPPED_SVG_ICON_SLUGS = new Set([
  "calendar",
  "camera",
  "chart",
  "chat",
  "code",
  "document",
  "files",
  "folder",
  "game",
  "grid",
  "globe",
  "layers",
  "mail",
  "messages",
  "music",
  "search",
  "settings",
  "terminal",
  "whiteboard",
  "workspace",
]);

const ICON_SLUG_ALIASES = new Map<string, string>([
  ["pomodoro", "pomodoro-timer"],
]);

const MAX_GRID_LABEL_CHARS = 13;

const NATIVE_SHELL_ICON_GLYPHS = new Map<string, keyof typeof Ionicons.glyphMap>([
  ["apps", "grid"],
  ["agents", "sparkles"],
  ["settings", "settings"],
]);

type IconCandidate = {
  uri: string;
  requiresAuth: boolean;
  kind: "raster" | "vector";
};

type AppSectionKey = "main" | "apps" | "games" | "results";

type AppSection = {
  key: AppSectionKey;
  title: string;
  apps: MatrixAppEntry[];
};

type LauncherListItem =
  | { type: "section"; key: string; title: string }
  | { type: "row"; key: string; apps: MatrixAppEntry[] };

// Mirror the web shell: the icon slug is `app.icon ?? app.slug ?? slug(name)`,
// where `icon` is a manifest KEY (e.g. "snake", "game"), not a path.
function iconSlugFor(app: MatrixAppEntry): string | undefined {
  return app.icon || app.slug || nameToSlug(app.name);
}

function nameToSlug(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || undefined;
}

function gridLabelFor(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_GRID_LABEL_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_GRID_LABEL_CHARS - 3).trimEnd()}...`;
}

function iconPathForSlug(slug: string | undefined): string | undefined {
  const normalizedSlug = slug?.toLowerCase();
  if (!normalizedSlug || !SAFE_ICON_SLUG.test(normalizedSlug)) return undefined;
  const iconSlug = ICON_SLUG_ALIASES.get(normalizedSlug) ?? normalizedSlug;
  const extension = APP_RASTER_ICON_SLUGS.has(iconSlug) || !SHIPPED_SVG_ICON_SLUGS.has(iconSlug) ? "png" : "svg";
  return `/icons/${encodeURIComponent(iconSlug)}.${extension}`;
}

function iconKind(uri: string): IconCandidate["kind"] {
  return /\.svg(?:$|[?#])/i.test(uri) ? "vector" : "raster";
}

// Ordered list of icon URLs to try. Normal manifest icons are keys, resolved via
// the same slug/extension table as the web shell. Gateway icon URLs are auth'd,
// so they are not requested until a bearer token is available.
function buildIconCandidates(app: MatrixAppEntry, gatewayUrl?: string): IconCandidate[] {
  const base = gatewayUrl ? gatewayUrl.replace(/\/+$/, "") : undefined;
  const list: IconCandidate[] = [];
  const icon = app.icon;
  if (icon && /^https?:\/\//.test(icon)) list.push({ uri: icon, requiresAuth: false, kind: iconKind(icon) });
  else if (icon && icon.startsWith("/") && base) {
    const uri = `${base}${icon}`;
    list.push({ uri, requiresAuth: true, kind: iconKind(uri) });
  }
  if (base) {
    const path = iconPathForSlug(iconSlugFor(app));
    if (path) {
      const uri = `${base}${path}`;
      list.push({ uri, requiresAuth: true, kind: iconKind(uri) });
    }
  }
  return list;
}

// Games live under apps/games/*; Main = built-in system apps.
function isGameApp(app: MatrixAppEntry): boolean {
  const file = app.file ?? "";
  const path = app.path ?? "";
  return file.startsWith("games/") || file.startsWith("apps/games/") || path.includes("/apps/games/");
}
function isMainApp(app: MatrixAppEntry): boolean {
  return (app.category ?? "").toLowerCase() === "system";
}

function buildAppSections(apps: MatrixAppEntry[]): AppSection[] {
  const main: MatrixAppEntry[] = [];
  const myApps: MatrixAppEntry[] = [];
  const games: MatrixAppEntry[] = [];

  for (const app of apps) {
    if (HIDDEN_APP_SLUGS.has(getAppSlug(app))) continue;
    if (isMainApp(app)) main.push(app);
    else if (isGameApp(app)) games.push(app);
    else myApps.push(app);
  }

  const sections: AppSection[] = [
    { key: "main", title: "Main", apps: main },
    { key: "apps", title: "My Apps", apps: myApps },
    { key: "games", title: "Games", apps: games },
  ];
  return sections.filter((section) => section.apps.length > 0);
}

function filterApps(apps: MatrixAppEntry[], query: string): MatrixAppEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return apps;
  return apps.filter((app) => {
    const haystack = `${app.name} ${app.description ?? ""} ${app.category ?? ""}`.toLowerCase();
    return haystack.includes(normalized);
  });
}

function rowsForApps(apps: MatrixAppEntry[], columns: number): MatrixAppEntry[][] {
  const rows: MatrixAppEntry[][] = [];
  for (let i = 0; i < apps.length; i += columns) {
    rows.push(apps.slice(i, i + columns));
  }
  return rows;
}

function buildLauncherListItems(sections: AppSection[], columns: number): LauncherListItem[] {
  return sections.flatMap((section) => [
    { type: "section" as const, key: `section-${section.key}`, title: section.title },
    ...rowsForApps(section.apps, columns).map((apps, idx) => ({
      type: "row" as const,
      key: `row-${section.key}-${idx}`,
      apps,
    })),
  ]);
}

// The shipped icon fills the squircle; on failure we step through the candidate
// URLs, then draw a tinted monogram — never a generic repeated glyph.
function AppTileGlyph({
  app,
  gatewayUrl,
  authHeader,
  tile,
}: {
  app: MatrixAppEntry;
  gatewayUrl?: string;
  authHeader?: string;
  tile: { bg: string; fg: string };
}) {
  const candidates = useMemo(() => buildIconCandidates(app, gatewayUrl), [app, gatewayUrl]);
  // Reset to the first candidate when the URL set OR auth changes. Auth can
  // arrive async, so a tile that 401'd before it landed must retry once it does.
  const resetKey = `${candidates.map((candidate) => candidate.uri).join("|")}|${authHeader ?? ""}`;
  const [idx, setIdx] = useState(0);
  const [prevKey, setPrevKey] = useState(resetKey);
  if (resetKey !== prevKey) {
    setPrevKey(resetKey);
    setIdx(0);
  }

  const shellGlyph = NATIVE_SHELL_ICON_GLYPHS.get(getAppSlug(app));
  if (shellGlyph) {
    return (
      <View style={styles.nativeShellIcon(shellGlyph === "settings" ? "settings" : "apps")}>
        <Ionicons name={shellGlyph} size={shellGlyph === "settings" ? 32 : 31} color="#F7F9F4" />
      </View>
    );
  }

  const candidate = candidates[idx];
  const canLoadCandidate = candidate && (!candidate.requiresAuth || authHeader);
  if (canLoadCandidate) {
    return (
      <Image
        source={{
          uri: candidate.uri,
          headers: candidate.requiresAuth && authHeader ? { Authorization: authHeader } : undefined,
        }}
        style={candidate.kind === "vector" ? styles.tileVectorImage : styles.tileImage}
        contentFit={candidate.kind === "vector" ? "contain" : "cover"}
        transition={120}
        cachePolicy="memory-disk"
        onError={() => setIdx((i) => i + 1)}
      />
    );
  }

  const letter = (app.name?.trim()?.[0] ?? "?").toUpperCase();
  return (
    <View style={styles.tileFallback(tile.bg)}>
      <View style={styles.tileGloss} pointerEvents="none" />
      <Text style={styles.monogram(tile.fg)}>{letter}</Text>
    </View>
  );
}

// One springboard cell: squircle icon tile + label beneath, fixed width so the
// columns line up even on a partial final row.
const AppGridItem = memo(function AppGridItem({
  app,
  gatewayUrl,
  authHeader,
  labelWidth,
  active,
  onOpen,
}: {
  app: MatrixAppEntry;
  gatewayUrl?: string;
  authHeader?: string;
  labelWidth: number;
  active: boolean;
  onOpen: (slug: string) => void;
}) {
  const slug = getAppSlug(app);
  const nativeRoute = getNativeAppRoute(app);
  const tile = tileFor(slug);
  const label = gridLabelFor(app.name);

  return (
    <Link href={(nativeRoute ?? appRuntimeHref(slug)) as any} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${app.name}`}
        onPress={() => {
          onOpen(slug);
          if (process.env.EXPO_OS === "ios") Haptics.selectionAsync();
        }}
        style={({ pressed }) => [styles.cell(labelWidth), pressed && styles.cellPressed]}
      >
        <View style={styles.tileShadow}>
          <View style={styles.tileClip}>
            <AppTileGlyph app={app} gatewayUrl={gatewayUrl} authHeader={authHeader} tile={tile} />
          </View>
          {active ? <View style={styles.activeDot} /> : null}
        </View>
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.cellLabel}>
          {label}
        </Text>
      </Pressable>
    </Link>
  );
});

function AppGridRow({
  apps,
  gatewayUrl,
  authHeader,
  cellWidth,
  columns,
  lastActiveAppSlug,
  onOpen,
}: {
  apps: MatrixAppEntry[];
  gatewayUrl?: string;
  authHeader?: string;
  cellWidth: number;
  columns: number;
  lastActiveAppSlug: string | null;
  onOpen: (slug: string) => void;
}) {
  return (
    <View style={styles.gridRow}>
      {apps.map((app) => (
        <View key={getAppSlug(app)} style={styles.gridSlot(cellWidth)}>
          <AppGridItem
            app={app}
            gatewayUrl={gatewayUrl}
            authHeader={authHeader}
            labelWidth={Math.min(cellWidth - 4, 84)}
            active={lastActiveAppSlug === getAppSlug(app)}
            onOpen={onOpen}
          />
        </View>
      ))}
      {Array.from({ length: Math.max(0, columns - apps.length) }, (_, idx) => (
        <View key={`spacer-${idx}`} style={styles.gridSlot(cellWidth)} />
      ))}
    </View>
  );
}

// "Jump back in" — the last-opened app as a single tappable card.
function RecentRow({
  app,
  gatewayUrl,
  authHeader,
  onOpen,
}: {
  app: MatrixAppEntry;
  gatewayUrl?: string;
  authHeader?: string;
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
        style={({ pressed }) => [styles.recentPressable, pressed && styles.recentRowPressed]}
      >
        <View style={styles.recentRow}>
          <View style={styles.recentTileShadow}>
            <View style={styles.recentTileClip}>
              <AppTileGlyph app={app} gatewayUrl={gatewayUrl} authHeader={authHeader} tile={tile} />
            </View>
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
  // Authorization header for authenticated icon image loads (the /icons endpoint is auth'd).
  const [authHeader, setAuthHeader] = useState<string | undefined>(undefined);

  const columns = width >= 600 ? 6 : 4;
  const gridWidth = Math.min(width - H_PADDING * 2, columns * 92);
  const cellWidth = Math.floor(gridWidth / columns);

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

  // Resolve a fresh Authorization header so authenticated icon URLs can load.
  useEffect(() => {
    let cancelled = false;
    if (!client) {
      Promise.resolve().then(() => {
        if (!cancelled) setAuthHeader(undefined);
      });
      return () => {
        cancelled = true;
      };
    }
    client
      .getAuthorizationHeader()
      .then((header) => {
        if (!cancelled) setAuthHeader(header);
      })
      .catch((err: unknown) => {
        console.warn("[mobile] failed to resolve auth token for icons", err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, connectionState]);

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

  const sections = useMemo(() => buildAppSections(apps), [apps]);
  const orderedApps = useMemo(() => sections.flatMap((section) => section.apps), [sections]);
  const displaySections = useMemo(() => {
    const normalized = query.trim();
    if (!normalized) return sections;
    return [{ key: "results" as const, title: "Results", apps: filterApps(orderedApps, normalized) }]
      .filter((section) => section.apps.length > 0);
  }, [orderedApps, query, sections]);
  const listItems = useMemo(
    () => buildLauncherListItems(displaySections, columns),
    [displaySections, columns],
  );

  const lastActiveApp = useMemo(() => {
    if (!lastActiveAppSlug) return null;
    return orderedApps.find((app) => getAppSlug(app) === lastActiveAppSlug) ?? null;
  }, [orderedApps, lastActiveAppSlug]);

  const handleRefresh = useCallback(async () => {
    dispatch({ type: "refreshStart" });
    await fetchApps();
    dispatch({ type: "refreshEnd" });
  }, [fetchApps]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<LauncherListItem>) => {
      if (item.type === "section") {
        return <Text style={styles.sectionLabel}>{item.title}</Text>;
      }
      return (
        <AppGridRow
          apps={item.apps}
          gatewayUrl={client?.httpUrl}
          authHeader={authHeader}
          cellWidth={cellWidth}
          columns={columns}
          lastActiveAppSlug={lastActiveAppSlug}
          onOpen={handleOpenApp}
        />
      );
    },
    [client, authHeader, cellWidth, columns, handleOpenApp, lastActiveAppSlug],
  );

  const refreshControl = useMemo(
    () => <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={theme.colors.accentInk} />,
    [refreshing, handleRefresh, theme.colors.accentInk],
  );

  const listHeader = useMemo(
    () => (
      <View>
        {query.trim() === "" && lastActiveApp ? (
          <View>
            <Text style={styles.sectionLabel}>Jump back in</Text>
            <RecentRow app={lastActiveApp} gatewayUrl={client?.httpUrl} authHeader={authHeader} onOpen={handleOpenApp} />
          </View>
        ) : null}
      </View>
    ),
    [query, lastActiveApp, client, authHeader, handleOpenApp],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerTitleGroup}>
          <Text style={styles.headerTitle}>Apps</Text>
          <Text style={styles.headerSubtitle}>
            {orderedApps.length} installed{connected ? "" : " · connecting…"}
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
          data={listItems}
          renderItem={renderItem}
          keyExtractor={(item) => item.key}
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
    fontFamily: theme.fonts.display,
    fontSize: 34,
    letterSpacing: -0.8,
    lineHeight: 38,
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
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: theme.glass.border,
    backgroundColor: theme.colors.field,
  },
  searchInput: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    color: theme.colors.ink,
    paddingVertical: 8,
  },
  sectionLabel: {
    fontFamily: theme.fonts.monoBold,
    fontSize: 11,
    letterSpacing: 0.9,
    textTransform: "uppercase",
    color: theme.colors.inkDim,
    paddingHorizontal: 4,
    paddingTop: 22,
    paddingBottom: 8,
  },
  listContent: { paddingHorizontal: H_PADDING, paddingBottom: 120 },
  gridRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  gridSlot: (w: number) => ({
    width: w,
    minHeight: 92,
    alignItems: "center" as const,
  }),

  // Grid cell + squircle tile
  cell: (w: number) => ({
    width: w,
    alignItems: "center" as const,
    gap: 6,
    paddingTop: 8,
    paddingBottom: 12,
  }),
  cellPressed: { opacity: 0.85, transform: [{ scale: 0.93 }] },
  tileShadow: {
    width: 56,
    height: 56,
    borderRadius: 16,
    borderCurve: "continuous",
    backgroundColor: theme.colors.panel,
    boxShadow: theme.shadows.card,
  },
  tileClip: {
    width: "100%",
    height: "100%",
    borderRadius: 16,
    borderCurve: "continuous",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glass.border,
    alignItems: "center",
    justifyContent: "center",
  },
  tileImage: { width: "100%", height: "100%" },
  tileVectorImage: {
    width: 34,
    height: 34,
    tintColor: theme.colors.forest,
  },
  nativeShellIcon: (variant: "apps" | "settings") => ({
    width: "100%" as const,
    height: "100%" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: variant === "apps" ? theme.colors.forest : theme.colors.moss,
  }),
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
  monogram: (fg: string) => ({
    fontFamily: theme.fonts.display,
    fontSize: 26,
    lineHeight: 30,
    color: fg,
  }),
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
    alignSelf: "stretch",
    paddingHorizontal: 2,
    fontFamily: theme.fonts.sansMedium,
    fontSize: 11,
    lineHeight: 14,
    textAlign: "center",
    color: theme.colors.ink,
  },

  // "Jump back in" card
  recentPressable: {
    alignSelf: "stretch",
    marginHorizontal: 4,
  },
  recentRow: {
    minHeight: 76,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 12,
    borderRadius: theme.radius.xl2,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: theme.glass.border,
    backgroundColor: theme.colors.panel,
    boxShadow: theme.shadows.card,
  },
  recentRowPressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  recentTileShadow: {
    width: 52,
    height: 52,
    borderRadius: 15,
    borderCurve: "continuous",
    backgroundColor: theme.colors.panel,
  },
  recentTileClip: {
    width: "100%",
    height: "100%",
    borderRadius: 15,
    borderCurve: "continuous",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glass.border,
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
    borderCurve: "continuous",
    backgroundColor: theme.colors.panel,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.glass.border,
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
