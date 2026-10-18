import { useCallback, useRef, useState } from "react";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowDown02Icon from "@hugeicons/core-free-icons/ArrowDown02Icon";
import ArrowLeft02Icon from "@hugeicons/core-free-icons/ArrowLeft02Icon";
import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";
import ArrowUp02Icon from "@hugeicons/core-free-icons/ArrowUp02Icon";
import ClipboardPasteIcon from "@hugeicons/core-free-icons/ClipboardPasteIcon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import { Icon, type IconData } from "@/components/ui/Icon";
import { buildTerminalControlSequence, type TerminalControlKey } from "@/lib/terminal-state";
import { sendTerminalClipboardPaste } from "@/lib/terminal-controls";
import { ARROW_SWIPE_START_PX, arrowKeysForSwipe, type ArrowSwipeState } from "@/lib/terminal-key-input";

interface TerminalControlBarProps {
  onSend: (data: string) => void;
  onScroll: (lines: number) => void;
  onScrollToBottom: () => void;
  onShowKeyboard: () => void;
  onDismissKeyboard: () => void;
  /** Whether the on-screen keyboard is up; the rows sit on it, or above the home indicator. */
  keyboardVisible: boolean;
  /** Whether the extra key pages are open under the main row. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Whether the next typed letter is sent as a control key. */
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
}

type KeyVariant = "primary" | "danger" | "arrow" | "symbol" | "tool";
type KeySize = "compact" | "normal" | "wide" | "grow";

type BarItem = {
  id: string;
  /** Spoken label, and the visible one unless `text` is given. */
  label: string;
  text?: string;
  icon?: IconData;
  // HugeIcons' keyboard reads as a face at this size; these are the familiar glyphs.
  keyboardGlyph?: "keyboard-outline" | "keyboard-close-outline";
  variant?: KeyVariant;
  size?: KeySize;
  selected?: boolean;
  onPress: () => void;
};

// Bottom padding of the rows when they sit on the keyboard.
const BAR_PADDING_BOTTOM = 6;
// How many lines Page up and Page down scroll.
const PAGE_LINES = 18;

/**
 * Key rows under the terminal: one row that is always shown, with the keys
 * coding agents need (interrupt, escape, tab, sticky ctrl, up and down, Enter),
 * and two pages of extra keys under it. A sideways swipe across the rows moves
 * the cursor; an up or down swipe sends up and down.
 */
export function TerminalControlBar({
  onSend,
  onScroll,
  onScrollToBottom,
  onShowKeyboard,
  onDismissKeyboard,
  keyboardVisible,
  expanded,
  onExpandedChange,
  ctrlArmed,
  onToggleCtrl,
}: TerminalControlBarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState<0 | 1>(0);
  const swipe = useArrowSwipe(onSend);

  const sendKey = (key: TerminalControlKey) => () => onSend(buildTerminalControlSequence(key));
  const sendText = (text: string) => () => onSend(text);

  const mainRow: BarItem[] = [
    { id: "stop", label: "Stop", variant: "danger", size: "grow", onPress: sendKey("ctrl-c") },
    { id: "escape", label: "esc", size: "compact", onPress: sendKey("escape") },
    { id: "tab", label: "tab", size: "compact", onPress: sendKey("tab") },
    { id: "ctrl", label: "ctrl", size: "wide", selected: ctrlArmed, onPress: onToggleCtrl },
    { id: "arrow-up", label: "Arrow up", icon: ArrowUp02Icon, variant: "arrow", onPress: sendKey("arrow-up") },
    { id: "arrow-down", label: "Arrow down", icon: ArrowDown02Icon, variant: "arrow", onPress: sendKey("arrow-down") },
    keyboardVisible
      ? { id: "keyboard", label: "Hide keyboard", keyboardGlyph: "keyboard-close-outline", variant: "tool", onPress: onDismissKeyboard }
      : { id: "keyboard", label: "Show keyboard", keyboardGlyph: "keyboard-outline", variant: "tool", onPress: onShowKeyboard },
    expanded
      ? { id: "expand", label: "Fewer keys", icon: ArrowDown01Icon, variant: "tool", onPress: () => onExpandedChange(false) }
      : {
        id: "expand",
        label: "More keys",
        icon: MoreHorizontalIcon,
        variant: "tool",
        onPress: () => {
          setPage(0);
          onExpandedChange(true);
        },
      },
    {
      id: "enter",
      label: "Enter",
      size: "grow",
      onPress: () => {
        onSend(buildTerminalControlSequence("enter"));
        // The answer comes after Enter, so the extra keys make room for it.
        if (expanded) onExpandedChange(false);
      },
    },
  ];
  // The page key shows the page in view; pressing it turns to the other one.
  const nextPage: BarItem = { id: "next-page", label: "Next keys page", text: "1/2", variant: "tool", size: "compact", onPress: () => setPage(1) };
  const previousPage: BarItem = { id: "previous-page", label: "Previous keys page", text: "2/2", variant: "tool", size: "compact", onPress: () => setPage(0) };
  const pages: { id: string; items: BarItem[] }[][] = [
    [
      { id: "page-1-keys", items: [
        { id: "arrow-left", label: "Arrow left", icon: ArrowLeft02Icon, variant: "arrow", onPress: sendKey("arrow-left") },
        { id: "arrow-right", label: "Arrow right", icon: ArrowRight02Icon, variant: "arrow", onPress: sendKey("arrow-right") },
        { id: "home", label: "Home", size: "grow", onPress: sendKey("ctrl-a") },
        { id: "end", label: "End", size: "grow", onPress: sendKey("ctrl-e") },
        { id: "shift-tab", label: "Shift tab", text: "⇧tab", size: "grow", onPress: sendKey("shift-tab") },
        { id: "paste", label: "Paste", text: "Paste", icon: ClipboardPasteIcon, variant: "tool", size: "grow", onPress: () => void sendTerminalClipboardPaste(onSend) },
        nextPage,
      ] },
      { id: "page-1-symbols", items: ["/", "~", "|", "-", "_", "$", "*", ">"].map((symbol) => ({
        id: `symbol-${symbol}`,
        label: symbol,
        variant: "symbol" as const,
        size: "grow" as const,
        onPress: sendText(symbol),
      })) },
    ],
    [
      { id: "page-2-editing", items: [
        { id: "kill-line", label: "Kill line", text: "Kill", size: "grow", onPress: sendKey("ctrl-u") },
        { id: "search-history", label: "Search history", text: "Find", size: "grow", onPress: sendKey("ctrl-r") },
        { id: "clear-screen", label: "Clear screen", text: "Clear", size: "grow", onPress: sendKey("ctrl-l") },
        previousPage,
      ] },
      { id: "page-2-scrolling", items: [
        { id: "page-up", label: "Page up", text: "PgUp", variant: "tool", size: "grow", onPress: () => onScroll(-PAGE_LINES) },
        { id: "page-down", label: "Page down", text: "PgDn", variant: "tool", size: "grow", onPress: () => onScroll(PAGE_LINES) },
        { id: "scroll-bottom", label: "Scroll to bottom", text: "Bottom", variant: "tool", size: "grow", onPress: onScrollToBottom },
      ] },
    ],
  ];
  const main = { id: "main-keys", items: mainRow };
  const rows = expanded ? [main, ...pages[page]!] : [main];

  const renderKey = (item: BarItem) => {
    const variant = item.variant ?? "primary";
    const tint = variant === "danger" ? theme.terminal.brightRed : theme.terminal.fg;
    const text = item.text ?? (item.icon || item.keyboardGlyph ? null : item.label);
    return (
      <Pressable
        key={item.id}
        accessibilityRole="button"
        accessibilityLabel={item.label}
        accessibilityState={item.selected === undefined ? undefined : { selected: item.selected }}
        onPress={item.onPress}
        style={({ pressed }) => [
          styles.key(variant, item.size),
          item.selected && styles.keySelected,
          pressed && styles.keyPressed,
        ]}
      >
        {item.icon ? <Icon icon={item.icon} size={variant === "arrow" ? 17 : 16} color={tint} /> : null}
        {item.keyboardGlyph ? <MaterialCommunityIcons name={item.keyboardGlyph} size={19} color={tint} /> : null}
        {text ? (
          <Text
            adjustsFontSizeToFit
            ellipsizeMode="clip"
            maxFontSizeMultiplier={1}
            minimumFontScale={0.65}
            numberOfLines={1}
            style={[styles.keyLabel(variant, item.size), item.selected && styles.keyLabelSelected]}
          >
            {text}
          </Text>
        ) : null}
      </Pressable>
    );
  };

  return (
    <View
      testID="terminal-control-bar"
      style={[
        styles.bar,
        { paddingBottom: keyboardVisible ? BAR_PADDING_BOTTOM : Math.max(BAR_PADDING_BOTTOM, insets.bottom) },
      ]}
      {...swipe}
    >
      {rows.map((row) => (
        <View key={row.id} testID="terminal-key-row" style={styles.row}>
          {row.items.map(renderKey)}
        </View>
      ))}
    </View>
  );
}

/**
 * Responder handlers that turn a swipe across the key rows into arrow keys. A
 * short wobble stays a tap on the key under the finger; once the finger has
 * clearly moved the rows take the touch from that key.
 */
function useArrowSwipe(onSend: (data: string) => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const state = useRef<ArrowSwipeState>({ axis: null, sent: 0 });

  const distance = (event: GestureResponderEvent) => {
    const origin = start.current;
    if (!origin) return null;
    return { dx: event.nativeEvent.pageX - origin.x, dy: event.nativeEvent.pageY - origin.y };
  };

  const reset = useCallback(() => {
    start.current = null;
    state.current = { axis: null, sent: 0 };
  }, []);

  return {
    onTouchStart: (event: GestureResponderEvent) => {
      start.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
      state.current = { axis: null, sent: 0 };
    },
    onMoveShouldSetResponderCapture: (event: GestureResponderEvent) => {
      const moved = distance(event);
      return !!moved && (Math.abs(moved.dx) >= ARROW_SWIPE_START_PX || Math.abs(moved.dy) >= ARROW_SWIPE_START_PX);
    },
    onResponderGrant: () => undefined,
    onResponderMove: (event: GestureResponderEvent) => {
      const moved = distance(event);
      if (!moved) return;
      const step = arrowKeysForSwipe(state.current, moved.dx, moved.dy);
      state.current = step.state;
      for (const key of step.keys) {
        onSend(buildTerminalControlSequence(key));
        stepHaptic();
      }
    },
    // A swipe that has started keeps the touch until the finger lifts.
    onResponderTerminationRequest: () => false,
    onResponderRelease: reset,
    onResponderTerminate: reset,
  };
}

function stepHaptic(): void {
  void Promise.resolve(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)).catch((error: unknown) => {
    console.warn("[mobile] terminal swipe haptic unavailable", error instanceof Error ? error.name : "unknown");
  });
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    borderTopWidth: 1,
    borderTopColor: theme.terminal.border,
    backgroundColor: theme.terminal.surface,
    paddingHorizontal: 6,
    paddingTop: 6,
    gap: 5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  // Keys keep their own width while a row fits and shrink together when it
  // does not, down to floors that fit every row in 320pt.
  key: (variant: KeyVariant, size: KeySize = "normal") => ({
    flexGrow: size === "grow" ? 1 : 0,
    flexShrink: 1,
    flexBasis: size === "grow"
      ? 0
      : size === "wide"
        ? 42
        : variant === "arrow" || variant === "symbol"
          ? 32
          : 34,
    minWidth: size === "grow" ? 30 : variant === "arrow" || variant === "symbol" ? 26 : 30,
    height: 36,
    paddingHorizontal: 4,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 4,
    borderRadius: 9,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: variant === "danger" ? "rgba(224, 106, 78, 0.38)" : theme.terminal.border,
    backgroundColor: variant === "danger"
      ? "rgba(224, 106, 78, 0.16)"
      : variant === "symbol"
        ? "rgba(225, 224, 224, 0.07)"
        : "rgba(225, 224, 224, 0.10)",
  }),
  // An armed key is drawn inverted, light on the dark rows.
  keySelected: {
    borderColor: theme.terminal.fg,
    backgroundColor: theme.terminal.fg,
  },
  keyPressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  keyLabel: (variant: KeyVariant, size?: KeySize) => ({
    fontFamily: variant === "symbol" || size === "compact" || size === "wide"
      ? theme.fonts.monoBold
      : theme.fonts.sansSemiBold,
    fontSize: variant === "symbol" ? 14 : 12.5,
    includeFontPadding: false,
    color: variant === "danger" ? theme.terminal.brightRed : theme.terminal.fg,
  }),
  keyLabelSelected: {
    color: theme.terminal.bg,
  },
}));
