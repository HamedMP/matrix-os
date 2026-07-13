import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useGateway } from "@/app/_layout";
import { FileBreadcrumbs } from "@/components/files/FileBreadcrumbs";
import { FileProjects } from "@/components/files/FileProjects";
import { FileRow } from "@/components/files/FileRow";
import { FileSearchRow } from "@/components/files/FileSearchRow";
import { FileViewer } from "@/components/files/FileViewer";
import {
  joinPath,
  listFiles,
  listProjects,
  searchFiles,
  sortEntries,
  type MatrixFileEntry,
  type MatrixFileSearchResult,
  type MatrixProject,
} from "@/lib/matrix-files";

const SEARCH_DEBOUNCE_MS = 300;

interface BrowseState {
  path: string;
  status: "loading" | "ready" | "error";
  entries: MatrixFileEntry[];
  nowMs: number;
  error: string | null;
  refreshing: boolean;
  projects: MatrixProject[];
  query: string;
  searchStatus: "idle" | "loading" | "ready" | "error";
  searchResults: MatrixFileSearchResult[];
  searchTruncated: boolean;
}

type BrowseAction =
  | { type: "navigate"; path: string }
  | { type: "loadStart" }
  | { type: "loaded"; entries: MatrixFileEntry[]; nowMs: number }
  | { type: "failed" }
  | { type: "refreshStart" }
  | { type: "refreshEnd" }
  | { type: "projectsLoaded"; projects: MatrixProject[] }
  | { type: "queryChanged"; query: string }
  | { type: "searchStart" }
  | { type: "searchLoaded"; results: MatrixFileSearchResult[]; truncated: boolean }
  | { type: "searchFailed" };

const INITIAL_STATE: BrowseState = {
  path: "",
  status: "loading",
  entries: [],
  nowMs: 0,
  error: null,
  refreshing: false,
  projects: [],
  query: "",
  searchStatus: "idle",
  searchResults: [],
  searchTruncated: false,
};

function reducer(state: BrowseState, action: BrowseAction): BrowseState {
  switch (action.type) {
    case "navigate":
      return {
        ...INITIAL_STATE,
        path: action.path,
        // Keep already-loaded projects; they are root-scoped and cheap to reuse.
        projects: action.path === "" ? state.projects : [],
      };
    case "loadStart":
      return { ...state, status: "loading", error: null };
    case "loaded":
      return { ...state, status: "ready", entries: action.entries, nowMs: action.nowMs };
    case "failed":
      return { ...state, status: "error" };
    case "refreshStart":
      return { ...state, refreshing: true };
    case "refreshEnd":
      return { ...state, refreshing: false };
    case "projectsLoaded":
      return { ...state, projects: action.projects };
    case "queryChanged":
      return action.query.trim() === ""
        ? { ...state, query: action.query, searchStatus: "idle", searchResults: [], searchTruncated: false }
        : { ...state, query: action.query };
    case "searchStart":
      return { ...state, searchStatus: "loading" };
    case "searchLoaded":
      return { ...state, searchStatus: "ready", searchResults: action.results, searchTruncated: action.truncated };
    case "searchFailed":
      return { ...state, searchStatus: "error" };
    default:
      return state;
  }
}

export default function FilesScreen() {
  const { theme } = useUnistyles();
  const { client } = useGateway();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [viewer, setViewer] = useState<{ entry: MatrixFileEntry; path: string } | null>(null);

  const { path, query } = state;
  const searching = query.trim() !== "";

  // Generation guards drop resolutions from a folder/query the user has already
  // navigated away from, so a slow response cannot overwrite the newer view.
  const listingGeneration = useRef(0);
  const searchGeneration = useRef(0);

  const loadListing = useCallback(async () => {
    const generation = listingGeneration.current + 1;
    listingGeneration.current = generation;
    if (!client) {
      dispatch({ type: "failed" });
      return;
    }
    dispatch({ type: "loadStart" });
    const result = await listFiles(client, path);
    if (generation !== listingGeneration.current) return;
    if (result.ok) {
      dispatch({ type: "loaded", entries: result.entries, nowMs: Date.now() });
    } else {
      dispatch({ type: "failed" });
    }
  }, [client, path]);

  useEffect(() => {
    void loadListing();
  }, [loadListing]);

  // Root-only project quick links; load once the root directory is active.
  useEffect(() => {
    if (!client || path !== "") return;
    let cancelled = false;
    void (async () => {
      const result = await listProjects(client);
      if (!cancelled && result.ok) dispatch({ type: "projectsLoaded", projects: result.projects });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, path]);

  // Debounced search within the current directory. Bump the generation on every
  // run (including when search is cleared) so an in-flight search cannot dispatch
  // results for a stale folder/query after the user moves on.
  useEffect(() => {
    const generation = searchGeneration.current + 1;
    searchGeneration.current = generation;
    if (!client || !searching) return;
    const timer = setTimeout(() => {
      dispatch({ type: "searchStart" });
      void (async () => {
        const result = await searchFiles(client, path, query);
        if (generation !== searchGeneration.current) return;
        if (result.ok) {
          dispatch({ type: "searchLoaded", results: result.results, truncated: result.truncated });
        } else {
          dispatch({ type: "searchFailed" });
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [client, path, query, searching]);

  const sortedEntries = useMemo(() => sortEntries(state.entries), [state.entries]);

  const handleEntryPress = useCallback(
    (entry: MatrixFileEntry) => {
      const fullPath = joinPath(path, entry.name);
      if (entry.type === "directory") {
        dispatch({ type: "navigate", path: fullPath });
      } else {
        setViewer({ entry, path: fullPath });
      }
    },
    [path],
  );

  const handleSearchPress = useCallback((result: MatrixFileSearchResult) => {
    if (result.type === "directory") {
      dispatch({ type: "navigate", path: result.path });
    } else {
      setViewer({
        entry: { name: result.name, type: "file", gitStatus: null },
        path: result.path,
      });
    }
  }, []);

  const handleNavigate = useCallback((next: string) => {
    dispatch({ type: "navigate", path: next });
  }, []);

  const handleProjectOpen = useCallback((project: MatrixProject) => {
    dispatch({ type: "navigate", path: project.path });
  }, []);

  const handleRefresh = useCallback(async () => {
    dispatch({ type: "refreshStart" });
    await loadListing();
    if (client && path === "") {
      const result = await listProjects(client);
      if (result.ok) dispatch({ type: "projectsLoaded", projects: result.projects });
    }
    dispatch({ type: "refreshEnd" });
  }, [loadListing, client, path]);

  const renderEntry = useCallback(
    ({ item }: ListRenderItemInfo<MatrixFileEntry>) => (
      <FileRow entry={item} nowMs={state.nowMs} onPress={handleEntryPress} />
    ),
    [state.nowMs, handleEntryPress],
  );

  const renderSearch = useCallback(
    ({ item }: ListRenderItemInfo<MatrixFileSearchResult>) => (
      <FileSearchRow result={item} onPress={handleSearchPress} />
    ),
    [handleSearchPress],
  );

  if (viewer && client) {
    return (
      <FileViewer
        key={viewer.path}
        client={client}
        entry={viewer.entry}
        path={viewer.path}
        onBack={() => setViewer(null)}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <FileBreadcrumbs path={path} onNavigate={handleNavigate} />
        <View style={styles.searchBar}>
          <Ionicons name="search" size={17} color={theme.colors.mutedForeground} />
          <TextInput
            value={query}
            onChangeText={(text) => dispatch({ type: "queryChanged", query: text })}
            placeholder="Search this folder"
            placeholderTextColor={theme.colors.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.searchInput}
          />
          {query ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              onPress={() => dispatch({ type: "queryChanged", query: "" })}
            >
              <Ionicons name="close-circle" size={18} color={theme.colors.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {searching ? (
        <FlatList
          data={state.searchStatus === "ready" ? state.searchResults : []}
          renderItem={renderSearch}
          keyExtractor={(item) => item.path}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            state.searchStatus === "ready" && state.searchTruncated ? (
              <Text style={styles.footerNote}>More results were hidden. Refine your search.</Text>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              status={state.searchStatus}
              onRetry={undefined}
              loadingText="Searching…"
              emptyIcon="search-outline"
              emptyTitle="No matches"
              emptyBody="Nothing in this folder matches your search."
            />
          }
        />
      ) : (
        <FlatList
          data={state.status === "ready" ? sortedEntries : []}
          renderItem={renderEntry}
          keyExtractor={(item) => item.name}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={state.refreshing} onRefresh={handleRefresh} tintColor={theme.colors.primary} />
          }
          ListHeaderComponent={
            path === "" ? <FileProjects projects={state.projects} onOpen={handleProjectOpen} /> : null
          }
          ListEmptyComponent={
            <EmptyState
              status={state.status}
              onRetry={() => void loadListing()}
              loadingText="Loading files…"
              emptyIcon="folder-open-outline"
              emptyTitle="Empty folder"
              emptyBody="This folder has no files yet."
            />
          }
        />
      )}
    </View>
  );
}

function EmptyState({
  status,
  onRetry,
  loadingText,
  emptyIcon,
  emptyTitle,
  emptyBody,
}: {
  status: "idle" | "loading" | "ready" | "error";
  onRetry: (() => void) | undefined;
  loadingText: string;
  emptyIcon: keyof typeof Ionicons.glyphMap;
  emptyTitle: string;
  emptyBody: string;
}) {
  const { theme } = useUnistyles();
  if (status === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.primary} />
        <Text style={styles.centerBody}>{loadingText}</Text>
      </View>
    );
  }
  if (status === "error") {
    return (
      <View style={styles.centered}>
        <Ionicons name="warning-outline" size={26} color={theme.colors.mutedForeground} />
        <Text style={styles.centerTitle}>Files unavailable. Try again.</Text>
        {onRetry ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={onRetry} style={styles.retryButton}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  if (status === "idle") return null;
  return (
    <View style={styles.centered}>
      <View style={styles.emptyIcon}>
        <Ionicons name={emptyIcon} size={26} color={theme.colors.primary} />
      </View>
      <Text style={styles.centerTitle}>{emptyTitle}</Text>
      <Text style={styles.centerBody}>{emptyBody}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  topBar: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  searchBar: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  searchInput: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    color: theme.colors.foreground,
    paddingVertical: 8,
  },
  listContent: { padding: theme.spacing.lg, gap: theme.spacing.sm, flexGrow: 1 },
  footerNote: {
    paddingVertical: theme.spacing.md,
    textAlign: "center",
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.mutedForeground,
  },
  centered: { flex: 1, minHeight: 220, alignItems: "center", justifyContent: "center", gap: theme.spacing.md, padding: theme.spacing.xl },
  emptyIcon: {
    width: 60,
    height: 60,
    borderRadius: theme.radius.xl,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  centerTitle: { fontFamily: theme.fonts.sansSemiBold, fontSize: 16, color: theme.colors.foreground, textAlign: "center" },
  centerBody: { fontFamily: theme.fonts.sans, fontSize: 13, color: theme.colors.mutedForeground, textAlign: "center", maxWidth: 260 },
  retryButton: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primary,
  },
  retryText: { fontFamily: theme.fonts.sansSemiBold, color: theme.colors.primaryForeground },
}));
