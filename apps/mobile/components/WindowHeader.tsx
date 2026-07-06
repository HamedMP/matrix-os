import React, { useCallback, useRef, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";

const DOUBLE_TAP_MS = 280;

export interface WindowHeaderProps {
  /** Safe-area-aware top padding (insets.top + a little breathing room). */
  paddingTop: number;
  title: string;
  /** Secondary line — e.g. the working directory. Hidden while maximized. */
  subtitle?: string;
  /** Render the subtitle in the mono face (paths, hosts). Defaults to true. */
  subtitleMono?: boolean;
  /** Single tap on the title group — e.g. open the session switcher. */
  onTitlePress?: () => void;
  /** Show a downward chevron next to the title to signal it opens a menu. */
  titleAffordance?: boolean;
  /** Leading control. Defaults to a back/close button when onBack is set. */
  onBack?: () => void;
  backIcon?: keyof typeof Ionicons.glyphMap;
  backLabel?: string;
  /** Trailing controls (already-built Pressables). */
  actions?: ReactNode;
  /** Collapsed/immersive state — shrinks the bar and drops the subtitle. */
  maximized?: boolean;
  tone?: "light" | "terminal";
  /** Double-tap the bar background to toggle maximize/restore. */
  onToggleMaximized?: () => void;
}

/**
 * Shared window chrome for every native Matrix OS surface (terminal, app
 * runtime, …). Keeping one header means every window looks and behaves the
 * same: a light shell bar over full-bleed content. Double-tapping the bar
 * background maximizes the window (collapses chrome) and double-tapping again
 * restores it — the same gesture as the desktop title bar.
 */
export function WindowHeader({
  paddingTop,
  title,
  subtitle,
  subtitleMono = true,
  onTitlePress,
  titleAffordance,
  onBack,
  backIcon = "chevron-back",
  backLabel = "Back",
  actions,
  maximized = false,
  tone = "light",
  onToggleMaximized,
}: WindowHeaderProps) {
  const { theme } = useUnistyles();
  const terminalTone = tone === "terminal";
  const lastTapRef = useRef(0);

  // Manual double-tap: the bar background is the only maximize target, so taps
  // on the back button / title / actions keep their own single-tap behavior.
  const handleBarPress = useCallback(() => {
    if (!onToggleMaximized) return;
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      onToggleMaximized();
    } else {
      lastTapRef.current = now;
    }
  }, [onToggleMaximized]);

  const TitleTag = onTitlePress ? Pressable : View;

  return (
    <Pressable
      onPress={handleBarPress}
      accessibilityHint={onToggleMaximized ? "Double tap to maximize or restore this window" : undefined}
      style={[
        styles.bar,
        terminalTone ? styles.barTerminal : null,
        maximized ? styles.barCompact : null,
        { paddingTop },
      ]}
    >
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          onPress={onBack}
          style={[
            styles.iconButton,
            terminalTone ? styles.iconButtonTerminal : null,
            maximized ? styles.iconButtonCompact : null,
          ]}
        >
          <Ionicons name={backIcon} size={20} color={terminalTone ? theme.terminal.fg : theme.colors.ink} />
        </Pressable>
      ) : null}

      <TitleTag
        {...(onTitlePress
          ? { accessibilityRole: "button" as const, accessibilityLabel: title, onPress: onTitlePress }
          : {})}
        style={styles.titleGroup}
      >
        <View style={styles.titleRow}>
          <Text
            style={[
              styles.title,
              terminalTone ? styles.titleTerminal : null,
              maximized && styles.titleCompact,
            ]}
            numberOfLines={1}
          >
            {title}
          </Text>
          {titleAffordance ? (
            <Ionicons name="chevron-down" size={13} color={terminalTone ? theme.terminal.fgDim : theme.colors.inkMuted} />
          ) : null}
        </View>
        {subtitle && !maximized ? (
          <Text
            style={[
              styles.subtitle,
              subtitleMono ? styles.subtitleMono : styles.subtitleSans,
              terminalTone ? styles.subtitleTerminal : null,
            ]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
      </TitleTag>

      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </Pressable>
  );
}

/** A trailing action button styled to match the window chrome. */
export function WindowHeaderAction({
  icon,
  label,
  onPress,
  tint,
  tone = "light",
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tint?: string;
  tone?: "light" | "terminal";
}) {
  const { theme } = useUnistyles();
  const terminalTone = tone === "terminal";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.actionButton, terminalTone ? styles.actionButtonTerminal : null]}
    >
      <Ionicons name={icon} size={19} color={tint ?? (terminalTone ? theme.terminal.fg : theme.colors.ink)} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingBottom: 10,
    backgroundColor: theme.colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.line,
  },
  barCompact: {
    gap: 8,
    paddingBottom: 5,
  },
  barTerminal: {
    backgroundColor: theme.terminal.surface,
    borderBottomColor: theme.terminal.border,
  },
  iconButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderCurve: "continuous",
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.line,
  },
  iconButtonTerminal: {
    backgroundColor: "rgba(228, 232, 222, 0.08)",
    borderColor: theme.terminal.border,
  },
  iconButtonCompact: {
    width: 32,
    height: 32,
    borderRadius: 10,
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  title: {
    fontFamily: theme.fonts.sansBold,
    color: theme.colors.foreground,
    fontSize: 18,
    letterSpacing: -0.3,
  },
  titleCompact: {
    fontSize: 15,
  },
  titleTerminal: {
    color: theme.terminal.fg,
  },
  subtitle: {
    marginTop: 2,
    fontSize: 12,
  },
  subtitleMono: {
    fontFamily: theme.fonts.mono,
    color: theme.colors.accentInk,
  },
  subtitleSans: {
    fontFamily: theme.fonts.sans,
    color: theme.colors.inkMuted,
  },
  subtitleTerminal: {
    color: theme.terminal.fgDim,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  actionButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 11,
    borderCurve: "continuous",
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.line,
  },
  actionButtonTerminal: {
    backgroundColor: "rgba(228, 232, 222, 0.08)",
    borderColor: theme.terminal.border,
  },
}));
