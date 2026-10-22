import { Children, Fragment, useState, type ReactNode } from "react";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import CubeIcon from "@hugeicons/core-free-icons/CubeIcon";
import { Text, TextInput, View, type ColorValue } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  CloseIcon,
  Icon,
  IconButton,
  PressableScale,
  SearchIcon,
  Skeleton,
  Spacer,
  type IconData,
} from "@/components/ui";
import { motion, size, type SpacingSize } from "@/lib/theme-v2";

const CLEAR_BUTTON_SIZE = 32;
const CLEAR_SLOP = (size.tapTarget - CLEAR_BUTTON_SIZE) / 2;

interface SearchFieldProps {
  placeholder?: string;
  value?: string;
  onChangeText?: (value: string) => void;
  /** False where the text is matched against names the keyboard would rewrite. */
  autoCorrect?: boolean;
}

export function SearchField({
  placeholder = "Search",
  value,
  onChangeText,
  autoCorrect,
}: SearchFieldProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState("");
  const { theme } = useUnistyles();
  const currentValue = value ?? uncontrolledValue;
  const updateValue = (nextValue: string) => {
    if (value === undefined) setUncontrolledValue(nextValue);
    onChangeText?.(nextValue);
  };

  return (
    <View style={styles.search}>
      <Icon icon={SearchIcon} size={16} color={theme.v2.colors.textSubtle} />
      <TextInput
        accessibilityLabel={placeholder}
        placeholder={placeholder}
        placeholderTextColor={theme.v2.colors.textTertiary}
        value={currentValue}
        onChangeText={updateValue}
        autoCorrect={autoCorrect}
        style={styles.searchInput}
      />
      {currentValue ? (
        <IconButton
          accessibilityLabel={`Clear ${placeholder}`}
          icon={CloseIcon}
          iconSize={18}
          buttonSize={CLEAR_BUTTON_SIZE}
          hitSlop={CLEAR_SLOP}
          onPress={() => updateValue("")}
        />
      ) : null}
    </View>
  );
}

interface GridTileProps {
  label: string;
  icon?: IconData;
  leading?: ReactNode;
  accent?: boolean;
  centered?: boolean;
  artworkLabelSpacerSize?: SpacingSize;
  iconBackgroundColor?: ColorValue;
  accessibilityLabel?: string;
  onPress?: () => void;
}

export function GridTileGrid({ children }: { children: ReactNode }) {
  const tiles = Children.toArray(children);
  const rows = Array.from(
    { length: Math.ceil(tiles.length / 3) },
    (_, index) => tiles.slice(index * 3, index * 3 + 3),
  );

  return (
    <View>
      {rows.map((row, index) => (
        <Fragment key={index}>
          <View style={styles.tileRow}>{row}</View>
          {index < rows.length - 1 ? <Spacer size="md" /> : null}
        </Fragment>
      ))}
    </View>
  );
}

export function FileTileSkeletonGrid() {
  return <GridTileSkeletonGrid testID="file-tile-skeleton" />;
}

export function GridTileSkeletonGrid({
  testID = "grid-tile-skeleton",
  variant = "card",
}: {
  testID?: string;
  /** "icon" for centered tiles, which draw an icon over a label and no tile behind them. */
  variant?: "card" | "icon";
}) {
  return (
    <View style={styles.tileRow}>
      {Array.from({ length: 3 }, (_, index) => (variant === "icon" ? (
        <View key={index} testID={testID} style={styles.skeletonIconTile}>
          <Spacer size="md" />
          <Skeleton testID={`${testID}-icon`} style={styles.skeletonIcon} />
          <Spacer size="md" />
          <Skeleton testID={`${testID}-label`} style={styles.skeletonLabel} />
        </View>
      ) : (
        <Skeleton
          key={index}
          testID={testID}
          shimmerTestID={`${testID}-shimmer`}
          style={styles.skeletonTile}
        />
      )))}
    </View>
  );
}

export function GridTile({
  label,
  icon = CubeIcon,
  leading,
  accent = false,
  centered = false,
  artworkLabelSpacerSize = "xl",
  iconBackgroundColor = "transparent",
  accessibilityLabel,
  onPress,
}: GridTileProps) {
  const { theme } = useUnistyles();
  return (
    <PressableScale
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel ?? `Open ${label}`}
      accessibilityState={onPress ? undefined : { disabled: true }}
      disabled={!onPress}
      onPress={onPress}
      style={[
        styles.tile,
        centered && styles.tileCentered,
        accent && styles.tileAccent,
      ]}
    >
      <Spacer size="md" />
      {leading ?? (
        <View
          testID={`grid-tile-icon-${label}`}
          style={[styles.tileGlyph, { backgroundColor: iconBackgroundColor }]}
        >
          <Icon icon={icon} size={24} color={accent ? theme.v2.appColors.blue : theme.v2.appColors.ink} />
        </View>
      )}
      <Spacer testID={centered ? "app-tile-artwork-label-spacer" : undefined} size={artworkLabelSpacerSize} />
      <Text
        numberOfLines={1}
        style={[styles.tileLabel, centered && styles.tileLabelCentered, accent && styles.tileLabelAccent]}
      >
        {label}
      </Text>
      <Spacer size="md" />
    </PressableScale>
  );
}

interface ListRowProps {
  title: string;
  detail?: string;
  detailLeading?: ReactNode;
  leading?: ReactNode;
  icon?: IconData;
  accent?: string;
  actionIcon?: IconData;
  action?: ReactNode;
  accessibilityLabel?: string;
  onPress?: () => void;
  onLongPress?: () => void;
}

/** Rows 12pt apart. The space is a gap rather than views between them, so a row that comes or goes moves alone. */
export function ListRowStack({ children }: { children: ReactNode }) {
  return <View style={styles.rowStack}>{children}</View>;
}

export function ListRowSkeletonStack({
  count = 3,
  testID = "list-row-skeleton",
}: {
  count?: number;
  testID?: string;
}) {
  return (
    <ListRowStack>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          key={index}
          testID={testID}
          shimmerTestID="terminal-skeleton-shimmer"
          style={styles.skeletonRow}
        />
      ))}
    </ListRowStack>
  );
}

export function ListRow({
  title,
  detail,
  detailLeading,
  leading,
  icon = CubeIcon,
  accent,
  actionIcon = ArrowRight01Icon,
  action,
  accessibilityLabel,
  onPress,
  onLongPress,
}: ListRowProps) {
  const { theme } = useUnistyles();
  const resolvedAccent = accent ?? theme.v2.appColors.soft;
  const content = (
    <>
      <Spacer size="md" />
      <View style={styles.rowContent}>
        {leading ?? (
          <View testID={`list-row-icon-${title}`} style={[styles.rowGlyph, { backgroundColor: resolvedAccent }]}>
            <Icon icon={icon} size={20} color={theme.v2.appColors.ink} />
          </View>
        )}
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{title}</Text>
          {detail ? (
            <>
              <Spacer size="xs" />
              <View style={styles.rowDetailLine}>
                {detailLeading}
                {detailLeading ? (
                  <Text
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    testID="terminal-session-agent-separator"
                    style={styles.rowDetail}
                  >
                    ·
                  </Text>
                ) : null}
                <Text numberOfLines={1} style={styles.rowDetail}>{detail}</Text>
              </View>
            </>
          ) : null}
        </View>
        {action ?? <Icon icon={actionIcon} size={18} color={theme.v2.appColors.muted} />}
      </View>
      <Spacer size="md" />
    </>
  );

  if (!onPress) {
    return <View style={styles.row}>{content}</View>;
  }

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `Open ${title}`}
      onPress={onPress}
      onLongPress={onLongPress}
      pressedScale={motion.rowPressScale}
      style={styles.row}
    >
      {content}
    </PressableScale>
  );
}

const styles = StyleSheet.create((theme) => ({
  search: {
    height: theme.v2.size.searchField,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[8],
    borderRadius: theme.v2.radius.field,
    paddingHorizontal: theme.v2.space[14],
    backgroundColor: theme.v2.colors.card,
  },
  // A one-line input centres its own text, so it takes no line height.
  searchInput: {
    flex: 1,
    alignSelf: "stretch",
    fontFamily: theme.v2.text.callout.fontFamily,
    fontSize: theme.v2.text.callout.fontSize,
    color: theme.v2.colors.textDefault,
  },
  tile: {
    width: "31.5%",
    aspectRatio: 0.9,
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    borderRadius: 18,
    paddingHorizontal: 12,
    backgroundColor: theme.v2.appColors.surface,
  },
  tileRow: {
    flexDirection: "row",
    columnGap: 10,
  },
  rowStack: {
    gap: theme.v2.spacing.md,
  },
  tileCentered: {
    flexDirection: "column",
    alignItems: "center",
    borderWidth: 0,
    backgroundColor: "transparent",
  },
  tileAccent: {
    borderColor: theme.v2.appColors.blue,
    backgroundColor: theme.v2.appColors.blueSoft,
  },
  tileGlyph: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 13,
  },
  skeletonTile: {
    width: "31.5%",
    aspectRatio: 0.9,
    borderRadius: 18,
  },
  skeletonIconTile: {
    width: "31.5%",
    aspectRatio: 0.9,
    alignItems: "center",
  },
  // The size and corners of an app's icon, and of its one-line label.
  skeletonIcon: {
    width: 64,
    height: 64,
    borderRadius: 16,
  },
  skeletonLabel: {
    width: "60%",
    height: 11,
    borderRadius: theme.v2.radius.full,
  },
  tileLabel: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 13,
    color: theme.v2.appColors.ink,
  },
  tileLabelCentered: {
    alignSelf: "stretch",
    textAlign: "center",
  },
  tileLabelAccent: {
    color: theme.v2.appColors.blue,
  },
  row: {
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    borderRadius: 16,
    paddingHorizontal: 13,
    backgroundColor: theme.v2.appColors.surface,
  },
  rowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
  },
  rowGlyph: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 15,
    color: theme.v2.appColors.ink,
  },
  rowDetail: {
    flexShrink: 1,
    fontFamily: theme.v2.fonts.body,
    fontSize: 12,
    color: theme.v2.appColors.muted,
  },
  rowDetailLine: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    columnGap: 5,
  },
  skeletonRow: {
    height: 66,
    borderRadius: 16,
    paddingHorizontal: 13,
  },
}));
