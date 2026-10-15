import { useEffect } from "react";
import { AccessibilityInfo, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { useReduceMotion } from "@/lib/use-reduce-motion";
import { TOAST_DURATION_MS, useToast, type Toast } from "@/lib/toast";

import { Icon } from "./Icon";
import { AlertIcon, CheckIcon } from "./icons";

/** How long a toast takes to fade in, and again to fade out before it ends. */
export const TOAST_FADE_MS = 180;
// How far it slides down as it appears, unless the person has asked for less motion.
const TOAST_SLIDE = 8;
const TOAST_ICON_SIZE = 16;
// Between the status bar and the toast.
const TOAST_GAP = 8;

/**
 * Draws the toast from `showToast` near the top of the screen, over whatever
 * is there and without taking its taps. Mounted once, at the root: it sits
 * above the tabs and the side panel, under screens shown as native modals.
 */
export function ToastHost() {
  const toast = useToast();
  const insets = useSafeAreaInsets();

  return (
    <View pointerEvents="box-none" style={[styles.host, { top: insets.top + TOAST_GAP }]}>
      {/* A new toast starts its own fade rather than taking over one half done. */}
      {toast ? <ToastPill key={toast.id} toast={toast} /> : null}
    </View>
  );
}

function ToastPill({ toast }: { toast: Toast }) {
  const { theme } = useUnistyles();
  const reduceMotion = useReduceMotion();
  const shown = useSharedValue(0);

  useEffect(() => {
    // Read out once on both platforms; a live region as well would read it twice on Android.
    AccessibilityInfo.announceForAccessibility(toast.message);
    shown.set(withTiming(1, { duration: TOAST_FADE_MS }));
    // The toast itself ends in `lib/toast`; this only fades it out first.
    const fadeOut = setTimeout(() => {
      shown.set(withTiming(0, { duration: TOAST_FADE_MS }));
    }, TOAST_DURATION_MS - TOAST_FADE_MS);
    return () => clearTimeout(fadeOut);
  }, [shown, toast]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: shown.get(),
    transform: [{ translateY: reduceMotion ? 0 : (shown.get() - 1) * TOAST_SLIDE }],
  }));

  return (
    <Animated.View
      testID="toast"
      accessibilityRole={toast.tone === "error" ? "alert" : undefined}
      style={[styles.pill, animatedStyle]}
    >
      <Icon
        icon={toast.tone === "error" ? AlertIcon : CheckIcon}
        size={TOAST_ICON_SIZE}
        color={theme.v2.colors.onControlPrimary}
        strokeWidth={2}
      />
      <Text style={styles.text}>{toast.message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: theme.v2.space[20],
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[8],
    maxWidth: "100%",
    borderRadius: theme.v2.radius.full,
    paddingHorizontal: theme.v2.space[16],
    paddingVertical: theme.v2.space[10],
    backgroundColor: theme.v2.colors.controlPrimary,
    boxShadow: theme.v2.designShadows.lg,
  },
  text: {
    ...theme.v2.text.labelMedium,
    flexShrink: 1,
    color: theme.v2.colors.onControlPrimary,
  },
}));
