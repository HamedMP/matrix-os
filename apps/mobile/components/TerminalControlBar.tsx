import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { buildTerminalControlSequence, type TerminalControlKey } from "@/lib/terminal-state";
import {
  sendTerminalClipboardPaste,
} from "@/lib/terminal-controls";

interface TerminalControlBarProps {
  onSend: (data: string) => void;
  onScroll: (lines: number) => void;
  onScrollToBottom: () => void;
  onDismissKeyboard: () => void;
  onFontScale: (delta: number) => void;
  onClear: () => void;
}

type BarItem =
  | { id: string; label: string; caption?: string; kind: "seq"; seq: TerminalControlKey; variant?: KeyVariant; size?: KeySize }
  | { id: string; label: string; caption?: string; kind: "text"; value: string; variant?: KeyVariant; size?: KeySize }
  | { id: string; label: string; caption?: string; kind: "font"; delta: number; variant?: KeyVariant; size?: KeySize }
  | { id: string; label: string; caption?: string; kind: "paste"; icon: keyof typeof Ionicons.glyphMap; variant?: KeyVariant; size?: KeySize }
  | { id: string; label: string; caption?: string; kind: "scroll"; lines: number; icon?: keyof typeof Ionicons.glyphMap; variant?: KeyVariant; size?: KeySize }
  | { id: string; label: string; caption?: string; kind: "bottom"; icon?: keyof typeof Ionicons.glyphMap; variant?: KeyVariant; size?: KeySize }
  | { id: string; label: string; caption?: string; kind: "dismiss"; icon?: keyof typeof Ionicons.glyphMap; variant?: KeyVariant; size?: KeySize }
  | { id: string; label: string; caption?: string; kind: "clear"; icon: keyof typeof Ionicons.glyphMap; variant?: KeyVariant; size?: KeySize }
  | { id: string; label: string; kind: "expand"; icon: keyof typeof Ionicons.glyphMap; variant?: KeyVariant; size?: KeySize }
  | { id: string; kind: "divider" };

type KeyVariant = "primary" | "danger" | "arrow" | "symbol" | "tool";
type KeySize = "compact" | "normal" | "wide" | "grow";

/**
 * Single compact accessory row (Termius-style) that floats just above the OS
 * keyboard. One horizontal strip keeps the terminal surface tall instead of a
 * multi-row pad eating half the screen.
 */
export function TerminalControlBar({
  onSend,
  onScroll,
  onScrollToBottom,
  onDismissKeyboard,
  onFontScale,
  onClear,
}: TerminalControlBarProps) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo<BarItem[][]>(() => {
    return [
      [
        { id: "ctrl-c", label: "Stop", kind: "seq", seq: "ctrl-c", variant: "danger", size: "wide" },
        { id: "escape", label: "esc", kind: "seq", seq: "escape", variant: "primary", size: "compact" },
        { id: "tab", label: "tab", kind: "seq", seq: "tab", variant: "primary", size: "compact" },
        { id: "paste", label: "Paste", kind: "paste", icon: "clipboard-outline", variant: "tool", size: "grow" },
        {
          id: "expand",
          label: expanded ? "Collapse" : "More",
          kind: "expand",
          icon: expanded ? "chevron-down" : "chevron-up",
          variant: "tool",
          size: "compact",
        },
        { id: "enter", label: "Enter", kind: "seq", seq: "enter", variant: "primary", size: "wide" },
      ],
      [
        { id: "zellij-prefix", label: "^P", caption: "zellij prefix", kind: "seq", seq: "ctrl-p", variant: "primary", size: "compact" },
        { id: "zellij-session", label: "^O", caption: "session mode", kind: "seq", seq: "ctrl-o", variant: "primary", size: "compact" },
        { id: "zellij-tab", label: "^T", caption: "tab mode", kind: "seq", seq: "ctrl-t", variant: "primary", size: "compact" },
        { id: "zellij-window", label: "^W", caption: "window/word", kind: "seq", seq: "ctrl-w", variant: "primary", size: "compact" },
        { id: "zellij-new", label: "^N", caption: "next/new", kind: "seq", seq: "ctrl-n", variant: "primary", size: "compact" },
        { id: "zellij-scroll", label: "^S", caption: "scroll mode", kind: "seq", seq: "ctrl-s", variant: "primary", size: "compact" },
        { id: "zellij-lock", label: "^G", caption: "lock mode", kind: "seq", seq: "ctrl-g", variant: "primary", size: "compact" },
      ],
      [
        { id: "arrow-left", label: "←", kind: "seq", seq: "arrow-left", variant: "arrow" },
        { id: "arrow-up", label: "↑", kind: "seq", seq: "arrow-up", variant: "arrow" },
        { id: "arrow-down", label: "↓", kind: "seq", seq: "arrow-down", variant: "arrow" },
        { id: "arrow-right", label: "→", kind: "seq", seq: "arrow-right", variant: "arrow" },
        { id: "home", label: "Home", kind: "seq", seq: "ctrl-a", variant: "primary", size: "grow" },
        { id: "end", label: "End", kind: "seq", seq: "ctrl-e", variant: "primary", size: "grow" },
      ],
      [
        { id: "ctrl-b", label: "^B", kind: "seq", seq: "ctrl-b", variant: "primary", size: "compact" },
        { id: "ctrl-f", label: "^F", kind: "seq", seq: "ctrl-f", variant: "primary", size: "compact" },
        { id: "ctrl-h", label: "^H", kind: "seq", seq: "ctrl-h", variant: "primary", size: "compact" },
        { id: "ctrl-j", label: "^J", kind: "seq", seq: "ctrl-j", variant: "primary", size: "compact" },
        { id: "ctrl-k", label: "^K", kind: "seq", seq: "ctrl-k", variant: "primary", size: "compact" },
        { id: "ctrl-l", label: "^L", kind: "seq", seq: "ctrl-l", variant: "primary", size: "compact" },
        { id: "ctrl-q", label: "^Q", kind: "seq", seq: "ctrl-q", variant: "primary", size: "compact" },
        { id: "clear-line", label: "Kill", kind: "seq", seq: "ctrl-u", variant: "primary", size: "grow" },
      ],
      [
        { id: "scroll-page-up", label: "PgUp", kind: "scroll", lines: -18, icon: "chevron-up", variant: "tool", size: "grow" },
        { id: "scroll-page-down", label: "PgDn", kind: "scroll", lines: 18, icon: "chevron-down", variant: "tool", size: "grow" },
        { id: "scroll-bottom", label: "Bottom", kind: "bottom", icon: "arrow-down-circle-outline", variant: "tool", size: "grow" },
        { id: "dismiss", label: "Done", kind: "dismiss", icon: "checkmark", variant: "tool", size: "grow" },
      ],
      [
        { id: "slash", label: "/", kind: "text", value: "/", variant: "symbol" },
        { id: "tilde", label: "~", kind: "text", value: "~", variant: "symbol" },
        { id: "pipe", label: "|", kind: "text", value: "|", variant: "symbol" },
        { id: "dash", label: "-", kind: "text", value: "-", variant: "symbol" },
        { id: "underscore", label: "_", kind: "text", value: "_", variant: "symbol" },
        { id: "dollar", label: "$", kind: "text", value: "$", variant: "symbol" },
        { id: "search", label: "Find", kind: "seq", seq: "ctrl-r", variant: "primary", size: "grow" },
      ],
    ];
  }, [expanded]);
  const visibleRows = expanded ? rows : rows.slice(0, 1);

  const renderKey = useCallback(
    (item: BarItem) => {
      if (item.kind === "divider") return <View style={styles.divider} />;
      let onPress: () => void;
      if (item.kind === "seq") onPress = () => onSend(buildTerminalControlSequence(item.seq));
      else if (item.kind === "text") onPress = () => onSend(item.value);
      else if (item.kind === "scroll") onPress = () => onScroll(item.lines);
      else if (item.kind === "bottom") onPress = onScrollToBottom;
      else if (item.kind === "font") onPress = () => onFontScale(item.delta);
      else if (item.kind === "paste") onPress = () => sendTerminalClipboardPaste(onSend);
      else if (item.kind === "dismiss") onPress = onDismissKeyboard;
      else if (item.kind === "expand") onPress = () => setExpanded((value) => !value);
      else onPress = onClear;
      const variant = item.kind === "seq" && item.variant === "danger" ? "danger" : item.variant ?? "primary";
      return (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={"caption" in item && item.caption ? `${item.label} ${item.caption}` : item.label}
          onPress={onPress}
          style={({ pressed }) => [styles.key(variant, item.size), pressed && styles.keyPressed]}
        >
          {"icon" in item && item.icon ? (
            <Ionicons
              name={item.icon}
              size={15}
              color={variant === "danger" ? theme.terminal.brightRed : theme.terminal.fg}
            />
          ) : null}
          {item.kind === "expand" ? null : (
            <Text
              adjustsFontSizeToFit
              ellipsizeMode="clip"
              maxFontSizeMultiplier={1}
              minimumFontScale={0.84}
              numberOfLines={1}
              style={variant === "danger" ? styles.keyLabelDanger : styles.keyLabel(item.variant ?? "primary", item.size)}
            >
              {item.label}
            </Text>
          )}
        </Pressable>
      );
    },
    [
      onSend,
      onScroll,
      onScrollToBottom,
      onDismissKeyboard,
      onFontScale,
      onClear,
      theme.terminal.brightRed,
      theme.terminal.fg,
    ],
  );

  return (
    <View style={styles.bar}>
      {visibleRows.map((row, idx) => (
        <View key={`row-${idx}`} style={styles.row}>
          {row.map(renderKey)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    borderTopWidth: 1,
    borderTopColor: theme.terminal.border,
    backgroundColor: theme.terminal.surface,
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 6,
    gap: 5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  key: (variant: KeyVariant, size: KeySize = "normal") => ({
    flexGrow: size === "grow" ? 1 : 0,
    flexShrink: 0,
    flexBasis: size === "compact"
      ? 40
      : size === "wide"
        ? 70
        : size === "grow"
          ? 0
        : variant === "arrow" || variant === "symbol"
          ? 36
          : 52,
    minWidth: size === "compact"
      ? 40
      : size === "wide"
        ? 70
        : size === "grow"
          ? 54
        : variant === "arrow" || variant === "symbol"
          ? 36
          : 52,
    height: 34,
    paddingHorizontal: variant === "arrow" || variant === "symbol" ? 7 : 8,
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
        ? "rgba(228, 232, 222, 0.07)"
        : "rgba(228, 232, 222, 0.10)",
  }),
  keyPressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  keyLabel: (variant: KeyVariant, size?: KeySize) => ({
    fontFamily: variant === "symbol" || variant === "arrow" || size === "compact"
      ? theme.fonts.monoBold
      : theme.fonts.sansSemiBold,
    fontSize: variant === "arrow" ? 15 : 12.5,
    includeFontPadding: false,
    color: theme.terminal.fg,
  }),
  keyLabelDanger: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 12.5,
    includeFontPadding: false,
    color: theme.terminal.brightRed,
  },
  divider: {
    width: 1,
    height: 24,
    marginHorizontal: 3,
    backgroundColor: theme.terminal.border,
  },
}));
