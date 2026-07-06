import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";

export default function CanvasEntryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { theme } = useUnistyles();

  const returnHome = useCallback(() => {
    loadMobileShellState()
      .then((state) => saveMobileShellState({
        ...state,
        mode: "launcher",
        updatedAt: new Date().toISOString(),
      }))
      .catch((err: unknown) => {
        console.warn("[mobile] failed to save canvas return state", err instanceof Error ? err.message : String(err));
      });
    router.replace("/(tabs)/apps" as any);
  }, [router]);

  const markCanvas = useCallback(() => {
    loadMobileShellState()
      .then((state) => saveMobileShellState({
        ...state,
        mode: "canvas",
        canvasEnteredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }))
      .catch((err: unknown) => {
        console.warn("[mobile] failed to save canvas state", err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + theme.spacing.lg, paddingBottom: Math.max(insets.bottom, theme.spacing.lg) }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Return to apps" onPress={returnHome} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={20} color={theme.colors.foreground} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>Canvas</Text>
          <Text style={styles.subtitle}>Desktop workspace</Text>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.glyph}>
          <Ionicons name="brush" size={36} color={theme.colors.primary} />
        </View>
        <Text style={styles.cardTitle}>Canvas opens best in the browser shell</Text>
        <Text style={styles.cardBody}>
          The native app keeps Canvas explicit so phone users never get trapped in a panned workspace. Use the browser shell when you need full spatial editing, then return here to keep using apps full-screen.
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Remember Canvas entry" onPress={markCanvas} style={styles.primaryButton}>
          <Text style={styles.primaryText}>Remember Canvas entry</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Apps" onPress={returnHome} style={styles.secondaryButton}>
          <Text style={styles.secondaryText}>Apps</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    paddingHorizontal: theme.spacing.lg,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  iconButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: theme.fonts.sansBold,
    fontSize: 20,
    color: theme.colors.foreground,
  },
  subtitle: {
    marginTop: 2,
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    color: theme.colors.mutedForeground,
  },
  card: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing.lg,
  },
  glyph: {
    width: 78,
    height: 78,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    marginBottom: theme.spacing.lg,
  },
  cardTitle: {
    textAlign: "center",
    fontFamily: theme.fonts.sansBold,
    fontSize: 22,
    color: theme.colors.foreground,
  },
  cardBody: {
    marginTop: theme.spacing.md,
    textAlign: "center",
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.mutedForeground,
  },
  primaryButton: {
    marginTop: theme.spacing.xl,
    minHeight: 48,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
  },
  primaryText: {
    fontFamily: theme.fonts.sansSemiBold,
    color: theme.colors.primaryForeground,
    fontSize: 15,
  },
  secondaryButton: {
    marginTop: theme.spacing.sm,
    minHeight: 48,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  secondaryText: {
    fontFamily: theme.fonts.sansSemiBold,
    color: theme.colors.foreground,
    fontSize: 15,
  },
}));
