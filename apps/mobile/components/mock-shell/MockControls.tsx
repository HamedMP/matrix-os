import { Children, Fragment, type ReactNode } from "react";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import CubeIcon from "@hugeicons/core-free-icons/CubeIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import { Pressable, StyleSheet, Text, TextInput, View, type ColorValue } from "react-native";

import { Icon, Skeleton, Spacer, type IconData } from "@/components/ui";
import { mockColors, mockFonts } from "./theme";

interface MockSearchFieldProps {
  placeholder?: string;
  value?: string;
  onChangeText?: (value: string) => void;
}

export function MockSearchField({
  placeholder = "Search",
  value,
  onChangeText,
}: MockSearchFieldProps) {
  return (
    <View style={styles.search}>
      <Icon icon={Search01Icon} size={17} color={mockColors.muted} />
      <TextInput
        accessibilityLabel={placeholder}
        placeholder={placeholder}
        placeholderTextColor={mockColors.muted}
        value={value}
        onChangeText={onChangeText}
        style={styles.searchInput}
      />
    </View>
  );
}

interface GridTileProps {
  label: string;
  icon: IconData;
  accent?: boolean;
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
  return (
    <View style={styles.tileRow}>
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton
          key={index}
          testID="file-tile-skeleton"
          shimmerTestID="file-tile-skeleton-shimmer"
          style={styles.skeletonTile}
        />
      ))}
    </View>
  );
}

export function GridTile({
  label,
  icon,
  accent = false,
  iconBackgroundColor = "transparent",
  accessibilityLabel,
  onPress,
}: GridTileProps) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel ?? `Open ${label}`}
      accessibilityState={onPress ? undefined : { disabled: true }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        accent && styles.tileAccent,
        pressed && styles.pressed,
      ]}
    >
      <Spacer size="md" />
      <View
        testID={`grid-tile-icon-${label}`}
        style={[styles.tileGlyph, { backgroundColor: iconBackgroundColor }]}
      >
        <Icon icon={icon} size={24} color={accent ? mockColors.blue : mockColors.ink} />
      </View>
      <Spacer size="xl" />
      <Text numberOfLines={1} style={[styles.tileLabel, accent && styles.tileLabelAccent]}>{label}</Text>
      <Spacer size="md" />
    </Pressable>
  );
}

interface ListRowProps {
  title: string;
  detail?: string;
  detailLeading?: ReactNode;
  icon?: IconData;
  accent?: string;
  actionIcon?: IconData;
  accessibilityLabel?: string;
  onPress: () => void;
}

export function ListRowStack({ children }: { children: ReactNode }) {
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
  icon = CubeIcon,
  accent = mockColors.soft,
  actionIcon = ArrowRight01Icon,
  accessibilityLabel,
  onPress,
}: ListRowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `Open ${title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Spacer size="md" />
      <View style={styles.rowContent}>
      <View testID={`list-row-icon-${title}`} style={[styles.rowGlyph, { backgroundColor: accent }]}>
          <Icon icon={icon} size={20} color={mockColors.ink} />
        </View>
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
        <Icon icon={actionIcon} size={18} color={mockColors.muted} />
      </View>
      <Spacer size="md" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  search: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 14,
    paddingHorizontal: 14,
    backgroundColor: mockColors.surface,
  },
  searchInput: {
    flex: 1,
    fontFamily: mockFonts.body,
    fontSize: 15,
    color: mockColors.ink,
  },
  tile: {
    width: "31.5%",
    aspectRatio: 0.9,
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 18,
    paddingHorizontal: 12,
    backgroundColor: mockColors.surface,
  },
  tileRow: {
    flexDirection: "row",
    columnGap: 10,
  },
  tileAccent: {
    borderColor: mockColors.blue,
    backgroundColor: mockColors.blueSoft,
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
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 18,
  },
  tileLabel: {
    fontFamily: mockFonts.semibold,
    fontSize: 13,
    color: mockColors.ink,
  },
  tileLabelAccent: {
    color: mockColors.blue,
  },
  row: {
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 16,
    paddingHorizontal: 13,
    backgroundColor: mockColors.surface,
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
    fontFamily: mockFonts.semibold,
    fontSize: 15,
    color: mockColors.ink,
  },
  rowDetail: {
    flexShrink: 1,
    fontFamily: mockFonts.body,
    fontSize: 12,
    color: mockColors.muted,
  },
  rowDetailLine: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    columnGap: 5,
  },
  skeletonRow: {
    height: 66,
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 16,
    paddingHorizontal: 13,
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.985 }],
  },
});
