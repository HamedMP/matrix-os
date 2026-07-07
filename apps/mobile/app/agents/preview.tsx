import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PreviewSessionSummarySchema, type PreviewSessionSummary } from "@matrix-os/contracts";
import AppRuntimeFrame from "@/components/AppRuntimeFrame";

type PreviewRouteParams = {
  id?: string | string[];
  label?: string | string[];
  status?: string | string[];
  origin?: string | string[];
  updatedAt?: string | string[];
};
type LaunchablePreview = PreviewSessionSummary & { origin: string };

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

function parsePreviewParams(params: PreviewRouteParams): LaunchablePreview | null {
  const parsed = PreviewSessionSummarySchema.safeParse({
    id: firstParam(params.id),
    label: firstParam(params.label),
    status: firstParam(params.status),
    origin: firstParam(params.origin),
    updatedAt: firstParam(params.updatedAt),
  });
  if (!parsed.success) return null;
  if (!isHttpsUrl(parsed.data.origin)) return null;
  return { ...parsed.data, origin: parsed.data.origin };
}

export default function AgentPreviewRoute() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const params = useLocalSearchParams<PreviewRouteParams>();
  const preview = useMemo(() => parsePreviewParams(params), [params]);

  if (!preview) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Preview" }} />
        <View style={styles.centered}>
          <View style={styles.iconBox}>
            <Ionicons name="warning-outline" size={28} color={theme.colors.moss} />
          </View>
          <Text style={styles.title}>Preview unavailable</Text>
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
