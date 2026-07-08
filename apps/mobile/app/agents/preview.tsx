import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PreviewSessionSummarySchema, type PreviewSessionSummary } from "@matrix-os/contracts";
import AppRuntimeFrame from "@/components/AppRuntimeFrame";
import { useGateway } from "@/app/_layout";

type PreviewRouteParams = {
  id?: string | string[];
};
type LaunchablePreview = PreviewSessionSummary & { origin: string };
type PreviewRouteState =
  | { status: "loading"; preview: null; error: null }
  | { status: "ready"; preview: LaunchablePreview; error: null }
  | { status: "error"; preview: null; error: "Preview unavailable" };

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function findLaunchablePreview(
  previews: PreviewSessionSummary[],
  previewId: string,
): LaunchablePreview | null {
  const preview = previews.find((candidate) => candidate.id === previewId) ?? null;
  if (!preview) return null;
  const parsed = PreviewSessionSummarySchema.safeParse(preview);
  if (!parsed.success) return null;
  if (parsed.data.status !== "running") return null;
  if (!parsed.data.updatedAt) return null;
  if (!isHttpsUrl(parsed.data.origin)) return null;
  return { ...parsed.data, origin: parsed.data.origin };
}

export default function AgentPreviewRoute() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const { client } = useGateway();
  const params = useLocalSearchParams<PreviewRouteParams>();
  const requestGeneration = useRef(0);
  const previewId = useMemo(() => {
    const value = firstParam(params.id);
    const parsed = PreviewSessionSummarySchema.shape.id.safeParse(value);
    return parsed.success ? parsed.data : null;
  }, [params.id]);
  const [state, setState] = useState<PreviewRouteState>({
    status: "loading",
    preview: null,
    error: null,
  });

  const loadPreview = useCallback(async (cancelled: () => boolean = () => false) => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    await Promise.resolve();
    if (cancelled() || generation !== requestGeneration.current) return;
    if (!client || !previewId) {
      setState({ status: "error", preview: null, error: "Preview unavailable" });
      return;
    }
    setState({ status: "loading", preview: null, error: null });
    let result;
    try {
      result = await client.getCodingAgentRuntimeSummary();
    } catch {
      console.warn("[agents-preview] preview summary refresh failed");
      if (!cancelled() && generation === requestGeneration.current) {
        setState({ status: "error", preview: null, error: "Preview unavailable" });
      }
      return;
    }
    if (cancelled() || generation !== requestGeneration.current) return;
    if (!result.ok) {
      setState({ status: "error", preview: null, error: "Preview unavailable" });
      return;
    }
    const preview = findLaunchablePreview(result.summary.previewSessions?.items ?? [], previewId);
    if (!preview) {
      setState({ status: "error", preview: null, error: "Preview unavailable" });
      return;
    }
    setState({ status: "ready", preview, error: null });
  }, [client, previewId]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadPreview(() => cancelled);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadPreview]);

  if (state.status === "loading") {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Preview" }} />
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.moss} />
          <Text style={styles.title}>Loading preview...</Text>
        </View>
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Preview" }} />
        <View style={styles.centered}>
          <View style={styles.iconBox}>
            <Ionicons name="warning-outline" size={28} color={theme.colors.moss} />
          </View>
          <Text style={styles.title}>{state.error}</Text>
          <Text style={styles.body}>Return to the agent workspace and refresh previews.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to agent workspace"
            onPress={() => router.back()}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed ? styles.buttonPressed : null,
            ]}
          >
            <Text style={styles.primaryButtonText}>Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const { preview } = state;
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: preview.label }} />
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to agent workspace"
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.headerButton,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Ionicons name="chevron-back" size={22} color={theme.colors.foreground} />
        </Pressable>
        <View style={styles.headerText}>
          <Text numberOfLines={1} style={styles.title}>{preview.label}</Text>
          <Text numberOfLines={1} style={styles.body}>{preview.status}</Text>
        </View>
      </View>
      <AppRuntimeFrame
        url={preview.origin}
        title={preview.label}
        canOpenExternalUrl={isHttpsUrl}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
  },
  iconBox: {
    width: 54,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  header: {
    minHeight: 62,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 17,
    color: theme.colors.foreground,
  },
  body: {
    fontFamily: theme.fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.mutedForeground,
    textAlign: "center",
  },
  primaryButton: {
    minHeight: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.xl,
  },
  primaryButtonText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.primaryForeground,
  },
  buttonPressed: {
    opacity: 0.82,
  },
}));
