import { useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { loadMobileShellState, saveMobileShellState } from "@/lib/mobile-shell-state";
import { colors, fonts, radius, spacing } from "@/lib/theme";

export default function CanvasEntryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

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
    <View style={[styles.screen, { paddingTop: insets.top + spacing.lg, paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Return to apps" onPress={returnHome} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={20} color={colors.light.foreground} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>Canvas</Text>
          <Text style={styles.subtitle}>Desktop workspace</Text>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.glyph}>
          <Ionicons name="brush" size={36} color={colors.light.primary} />
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

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.light.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  iconButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 20,
    color: colors.light.foreground,
  },
  subtitle: {
    marginTop: 2,
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.light.mutedForeground,
  },
  card: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  glyph: {
    width: 78,
    height: 78,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    marginBottom: spacing.lg,
  },
  cardTitle: {
    textAlign: "center",
    fontFamily: fonts.sansBold,
    fontSize: 22,
    color: colors.light.foreground,
  },
  cardBody: {
    marginTop: spacing.md,
    textAlign: "center",
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.light.mutedForeground,
  },
  primaryButton: {
    marginTop: spacing.xl,
    minHeight: 48,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.lg,
    backgroundColor: colors.light.primary,
  },
  primaryText: {
    fontFamily: fonts.sansSemiBold,
    color: colors.light.primaryForeground,
    fontSize: 15,
  },
  secondaryButton: {
    marginTop: spacing.sm,
    minHeight: 48,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
  },
  secondaryText: {
    fontFamily: fonts.sansSemiBold,
    color: colors.light.foreground,
    fontSize: 15,
  },
});
