import { Children, Fragment, type ReactNode } from "react";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import {
  Pressable,
  ScrollView,
  Text as NativeText,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Divider, Icon, Spacer, type IconData } from "@/components/ui";

export function SettingsPage({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.pageContent}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Spacer size="lg" />
      {children}
      <Spacer size="3xl" />
    </ScrollView>
  );
}

export function SettingsGroup({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <View style={styles.group}>
      {rows.map((row, index) => (
        <Fragment key={index}>
          {row}
          {index < rows.length - 1 ? <Divider style={styles.divider} /> : null}
        </Fragment>
      ))}
    </View>
  );
}

export function SettingsCardStack({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <View>
      {rows.map((row, index) => (
        <Fragment key={index}>
          {row}
          {index < rows.length - 1 ? <Spacer size="md" /> : null}
        </Fragment>
      ))}
    </View>
  );
}

interface SettingsRowProps {
  title: string;
  detail?: string;
  icon?: IconData;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  tone?: "default" | "danger";
  card?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function SettingsRow({
  title,
  detail,
  icon,
  leading,
  trailing,
  onPress,
  accessibilityLabel,
  tone = "default",
  card = false,
  style,
}: SettingsRowProps) {
  const { theme } = useUnistyles();
  const content = (
    <>
      <Spacer size="md" />
      <View style={styles.rowContent}>
        {leading ?? (icon ? (
          <View style={styles.iconSurface}>
            <Icon icon={icon} size={21} color={tone === "danger" ? theme.v2.palette.coral[600] : theme.v2.appColors.ink} />
          </View>
        ) : null)}
        <View style={styles.copy}>
          <NativeText style={[styles.title, tone === "danger" ? styles.danger : null]}>{title}</NativeText>
          {detail ? (
            <>
              <Spacer size="xs" />
              <NativeText numberOfLines={2} style={styles.detail}>{detail}</NativeText>
            </>
          ) : null}
        </View>
        {trailing ?? (onPress ? <Icon icon={ArrowRight01Icon} size={18} color={theme.v2.appColors.muted} /> : null)}
      </View>
      <Spacer size="md" />
    </>
  );
  const rowStyle = [styles.row, card ? styles.card : null, style];

  if (!onPress) return <View style={rowStyle}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `Open ${title}`}
      onPress={onPress}
      style={({ pressed }) => [rowStyle, pressed ? styles.pressed : null]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.v2.appColors.canvas,
  },
  pageContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
  },
  group: {
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    borderRadius: 16,
    backgroundColor: theme.v2.appColors.surface,
  },
  divider: {
    marginHorizontal: 14,
  },
  row: {
    paddingHorizontal: 14,
    backgroundColor: theme.v2.appColors.surface,
  },
  card: {
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    borderRadius: 16,
  },
  rowContent: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 13,
  },
  iconSurface: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 16,
    color: theme.v2.appColors.ink,
  },
  detail: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 13,
    color: theme.v2.appColors.muted,
  },
  danger: {
    color: theme.v2.palette.coral[600],
  },
  pressed: {
    opacity: 0.7,
  },
}));
