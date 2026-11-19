import { Children, Fragment, type ReactNode, type Ref } from "react";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import {
  Pressable,
  ScrollView,
  Switch,
  Text as NativeText,
  View,
  type ScrollViewInstance,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Divider, Icon, PressableScale, Spacer, type IconData } from "@/components/ui";
import { selectHaptic } from "@/lib/haptics";
import { motion } from "@/lib/theme-v2";

export function SettingsPage({ children, scrollRef }: {
  children: ReactNode;
  /** For screens that scroll themselves, e.g. back to a notice after an action. */
  scrollRef?: Ref<ScrollViewInstance>;
}) {
  return (
    <ScrollView
      ref={scrollRef}
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
  /** Zero keeps long identity/configuration values fully readable. */
  detailNumberOfLines?: number;
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
  detailNumberOfLines = 2,
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
    <SettingsRowContent
      title={title}
      detail={detail}
      detailNumberOfLines={detailNumberOfLines}
      icon={icon}
      leading={leading}
      trailing={trailing ?? (onPress ? <Icon icon={ArrowRight01Icon} size={18} color={theme.v2.appColors.muted} /> : null)}
      tone={tone}
    />
  );
  const rowStyle = [styles.row, card ? styles.card : null, style];

  if (!onPress) return <View style={rowStyle}>{content}</View>;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `Open ${title}`}
      onPress={onPress}
      pressedScale={motion.rowPressScale}
      style={rowStyle}
    >
      {content}
    </PressableScale>
  );
}

interface SettingsSwitchRowProps {
  title: string;
  detail?: string;
  icon?: IconData;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  card?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A row with a switch at its end. The switch takes taps across the row's
 * whole height and out to its edge, so it is easy to hit; the title and
 * detail do nothing. The switch drawn there only shows the value, so a tap
 * toggles once and screen readers find a single switch named by the title.
 */
export function SettingsSwitchRow({
  title,
  detail,
  icon,
  value,
  onValueChange,
  disabled = false,
  card = false,
  style,
}: SettingsSwitchRowProps) {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.row, styles.switchRow, card ? styles.card : null, style]}>
      <View style={styles.copy}>
        <SettingsRowContent title={title} detail={detail} icon={icon} />
      </View>
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={title}
        accessibilityState={{ checked: value, disabled }}
        disabled={disabled}
        onPress={() => {
          if (disabled) return;
          selectHaptic();
          onValueChange(!value);
        }}
        style={styles.switchTarget}
      >
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Switch
            disabled={disabled}
            value={value}
            trackColor={{ false: theme.v2.appColors.line, true: theme.v2.appColors.green }}
            thumbColor={theme.v2.appColors.surface}
          />
        </View>
      </Pressable>
    </View>
  );
}

function SettingsRowContent({
  title,
  detail,
  detailNumberOfLines = 2,
  icon,
  leading,
  trailing,
  tone = "default",
}: Pick<SettingsRowProps, "title" | "detail" | "detailNumberOfLines" | "icon" | "leading" | "trailing" | "tone">) {
  const { theme } = useUnistyles();
  return (
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
              <NativeText numberOfLines={detailNumberOfLines} style={styles.detail}>{detail}</NativeText>
            </>
          ) : null}
        </View>
        {trailing}
      </View>
      <Spacer size="md" />
    </>
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
  switchRow: {
    flexDirection: "row",
  },
  // Spans the row's full height and runs past its padding to the edge.
  switchTarget: {
    justifyContent: "center",
    paddingLeft: 16,
    paddingRight: 14,
    marginRight: -14,
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
}));
