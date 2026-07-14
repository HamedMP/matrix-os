import { useCallback, useEffect, useReducer, useRef } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { GatewayClient } from "@/lib/gateway-client";
import {
  formatFileSize,
  isImageFile,
  readTextFile,
  type MatrixFileEntry,
} from "@/lib/matrix-files";

type ViewerState =
  | { status: "loading" }
  | { status: "text"; content: string }
  | { status: "image"; authHeader?: string }
  | { status: "unpreviewable"; reason: "too-large" | "binary" | "unknown-size"; size?: number }
  | { status: "error" };

function viewerReducer(_state: ViewerState, action: ViewerState): ViewerState {
  return action;
}

export function FileViewer({
  client,
  entry,
  path,
  onBack,
}: {
  client: GatewayClient;
  entry: MatrixFileEntry;
  path: string;
  onBack: () => void;
}) {
  const { theme } = useUnistyles();
  const [state, dispatch] = useReducer(viewerReducer, { status: "loading" });
  const isImage = isImageFile(entry.name);
  // Shared cancellation flag so both the mount effect and manual retry stop
  // dispatching once this view unmounts.
  const requestIdRef = useRef(0);

  // Resolves the preview to its terminal state. Never dispatches "loading"
  // itself, so the mount effect stays cascading-render free; the initial state
  // is already "loading" and the screen remounts this view per file via `key`.
  const resolvePreview = useCallback(
    async (isCancelled: () => boolean) => {
      if (isImage) {
        try {
          const authHeader = await client.getAuthorizationHeader();
          if (!isCancelled()) dispatch({ status: "image", authHeader });
        } catch {
          if (!isCancelled()) dispatch({ status: "error" });
        }
        return;
      }
      const result = await readTextFile(client, path);
      if (isCancelled()) return;
      if (result.ok) {
        dispatch({ status: "text", content: result.content });
      } else if (result.reason === "unavailable") {
        dispatch({ status: "error" });
      } else {
        dispatch({ status: "unpreviewable", reason: result.reason, size: result.size });
      }
    },
    [client, path, isImage],
  );

  // Per-request token: each load (mount or retry) invalidates every earlier
  // in-flight resolution, so a retry cannot un-cancel a previous call and let
  // its stale result dispatch over the fresh one.
  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    void resolvePreview(() => requestIdRef.current !== requestId);
    return () => {
      requestIdRef.current += 1;
    };
  }, [resolvePreview]);

  const handleRetry = useCallback(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    dispatch({ status: "loading" });
    void resolvePreview(() => requestIdRef.current !== requestId);
  }, [resolvePreview]);

  const sizeLabel = formatFileSize(entry.size);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to files"
          onPress={onBack}
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
        >
          <Ionicons name="arrow-back" size={20} color={theme.colors.foreground} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {entry.name}
          </Text>
          {sizeLabel ? <Text style={styles.subtitle}>{sizeLabel}</Text> : null}
        </View>
      </View>

      {state.status === "loading" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : null}

      {state.status === "error" ? (
        <View style={styles.centered}>
          <Ionicons name="warning-outline" size={26} color={theme.colors.mutedForeground} />
          <Text style={styles.centerTitle}>Preview unavailable. Try again.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry preview"
            onPress={handleRetry}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {state.status === "unpreviewable" ? (
        <View style={styles.centered}>
          <Ionicons name="document-outline" size={26} color={theme.colors.mutedForeground} />
          <Text style={styles.centerTitle}>
            {state.reason === "too-large"
              ? "File is too large to preview"
              : state.reason === "unknown-size"
                ? "Preview unavailable for this file"
                : "Preview not available"}
          </Text>
          {sizeLabel || state.size ? (
            <Text style={styles.centerBody}>{sizeLabel || formatFileSize(state.size)}</Text>
          ) : null}
        </View>
      ) : null}

      {state.status === "image" ? (
        <ScrollView
          contentContainerStyle={styles.imageScroll}
          maximumZoomScale={4}
          minimumZoomScale={1}
          showsVerticalScrollIndicator={false}
        >
          <Image
            accessibilityLabel={entry.name}
            source={{
              uri: client.homeFileUrl(path),
              headers: state.authHeader ? { Authorization: state.authHeader } : undefined,
            }}
            style={styles.image}
            contentFit="contain"
            transition={120}
            onError={() => dispatch({ status: "error" })}
          />
        </ScrollView>
      ) : null}

      {state.status === "text" ? (
        <ScrollView style={styles.textScroll} contentContainerStyle={styles.textScrollContent}>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <Text selectable style={styles.code}>
              {state.content}
            </Text>
          </ScrollView>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  backButtonPressed: { opacity: 0.7 },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontFamily: theme.fonts.sansSemiBold, fontSize: 16, color: theme.colors.foreground },
  subtitle: { marginTop: 2, fontFamily: theme.fonts.mono, fontSize: 11, color: theme.colors.mutedForeground },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing.md, padding: theme.spacing.xl },
  centerTitle: { fontFamily: theme.fonts.sansSemiBold, fontSize: 15, color: theme.colors.foreground, textAlign: "center" },
  centerBody: { fontFamily: theme.fonts.mono, fontSize: 12, color: theme.colors.mutedForeground },
  retryButton: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primary,
  },
  retryText: { fontFamily: theme.fonts.sansSemiBold, color: theme.colors.primaryForeground },
  imageScroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing.lg },
  image: { width: "100%", height: 320 },
  textScroll: { flex: 1 },
  textScrollContent: { padding: theme.spacing.lg },
  code: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
}));
