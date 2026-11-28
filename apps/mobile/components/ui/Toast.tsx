import { useEffect } from "react";
import { RUNTIME_WAKE_MESSAGES } from "@matrix-os/contracts/runtime-lifecycle";
import { AccessibilityInfo, Platform, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { runtimeWakeTracker, type RuntimeWakeTracker } from "@/lib/requests/http";
import { useReduceMotion } from "@/lib/use-reduce-motion";
import { TOAST_DURATION_MS, dismissToast, showToast, useToast, type Toast } from "@/lib/toast";

import { Icon } from "./Icon";
import { AlertIcon, CheckIcon, LoadingIcon } from "./icons";

/** How long a toast takes to fade in, and again to fade out before it ends. */
export const TOAST_FADE_MS = 180;
// How far it slides down as it appears, unless the person has asked for less motion.
const TOAST_SLIDE = 8;
const TOAST_ICON_SIZE = 16;
const TOAST_ICONS = { success: CheckIcon, error: AlertIcon, progress: LoadingIcon } as const;
// Between the status bar and the toast.
const TOAST_GAP = 8;

/**
 * Draws the toast from `showToast` near the top of the screen, over whatever
 * is there and without taking its taps. Mounted once, at the root, above the
 * tabs and the side panel.
 */
export function ToastHost({ wakeSource = runtimeWakeTracker }: { wakeSource?: RuntimeWakeSource | null } = {}) {
  useRuntimeWakeNotice(wakeSource);
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const host = (
    <View testID="toast-host" pointerEvents="box-none" style={[styles.host, { top: insets.top + TOAST_GAP }]}>
      {/* A new toast starts its own fade rather than taking over one half done. */}
      {toast ? <ToastPill key={toast.id} toast={toast} /> : null}
    </View>
  );
  // iOS draws a native modal over the whole app, this host included. While a
  // toast shows, it goes in an overlay above the window's contents, put there
  // as it appears so it lands above a modal already open. The overlay takes no
  // taps of its own.
  if (toast && Platform.OS === "ios") return <FullWindowOverlay>{host}</FullWindowOverlay>;
  return host;
}

type RuntimeWakeSource = Pick<RuntimeWakeTracker, "subscribe">;

/**
 * Shows the shared gateway waking state (spec 2691, ENG-520) through the
 * shared toast host: "Waking your Matrix computer…" while a request has
 * waited 3 s or more for a wake and any request is still waiting, and the
 * typed reason when one request stops retrying.
 * Holds no React state, so nothing updates after it unmounts.
 */
function useRuntimeWakeNotice(source: RuntimeWakeSource | null) {
  useEffect(() => {
    if (!source) return undefined;
    let noticeId: number | null = null;
    // Parallel requests fail together; say it once, with one haptic.
    let lastFailure: { code: string; at: number } | null = null;
    const hideNotice = () => {
      if (noticeId === null) return;
      dismissToast(noticeId);
      noticeId = null;
    };
    const unsubscribe = source.subscribe((event) => {
      if (event.type === "failed") {
        // A failure ends only that request's wait. The tracker sends `visible: false` once no request
        // is waiting; until then the persistent notice stays and returns after this temporary toast.
        const now = Date.now();
        if (lastFailure?.code === event.code && now - lastFailure.at < TOAST_DURATION_MS) return;
        lastFailure = { code: event.code, at: now };
        showToast(RUNTIME_WAKE_MESSAGES[event.code], "error");
        return;
      }
      if (!event.visible) {
        hideNotice();
        return;
      }
      if (noticeId === null) {
        noticeId = showToast(RUNTIME_WAKE_MESSAGES.notice, "progress", { persistent: true });
      }
    });
    return () => {
      unsubscribe();
      hideNotice();
    };
  }, [source]);
}

function ToastPill({ toast }: { toast: Toast }) {
  const { theme } = useUnistyles();
  const reduceMotion = useReduceMotion();
  const shown = useSharedValue(0);

  useEffect(() => {
    // Read out once on both platforms; a live region as well would read it twice on Android.
    AccessibilityInfo.announceForAccessibility(toast.message);
    shown.set(withTiming(1, { duration: TOAST_FADE_MS }));
    // A persistent toast is taken away by whoever showed it, without a fade.
    if (toast.persistent) return undefined;
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
        icon={TOAST_ICONS[toast.tone]}
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
