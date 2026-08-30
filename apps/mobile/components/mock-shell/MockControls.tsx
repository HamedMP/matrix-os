import type { ComponentProps } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { mockColors, mockFonts } from "./theme";

type IconName = ComponentProps<typeof Ionicons>["name"];

export function MockSearchField({ placeholder = "Search" }: { placeholder?: string }) {
  return (
    <View style={styles.search}>
      <Ionicons name="search-outline" size={17} color={mockColors.muted} />
      <TextInput
        accessibilityLabel={placeholder}
        placeholder={placeholder}
        placeholderTextColor={mockColors.muted}
        style={styles.searchInput}
      />
    </View>
  );
}

interface GridTileProps {
  label: string;
  icon: IconName;
  accent?: boolean;
  accessibilityLabel?: string;
  onPress: () => void;
}

export function GridTile({ label, icon, accent = false, accessibilityLabel, onPress }: GridTileProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `Open ${label}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        accent && styles.tileAccent,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.tileGlyph, accent && styles.tileGlyphAccent]}>
        <Ionicons name={icon} size={24} color={accent ? mockColors.blue : mockColors.ink} />
      </View>
      <Text numberOfLines={1} style={[styles.tileLabel, accent && styles.tileLabelAccent]}>{label}</Text>
    </Pressable>
  );
}

interface ListRowProps {
  title: string;
  detail?: string;
  icon?: IconName;
  accent?: string;
  actionIcon?: IconName;
  accessibilityLabel?: string;
  onPress: () => void;
}

export function ListRow({
  title,
  detail,
  icon = "cube-outline",
  accent = mockColors.soft,
  actionIcon = "chevron-forward",
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
      <View style={[styles.rowGlyph, { backgroundColor: accent }]}>
        <Ionicons name={icon} size={20} color={mockColors.ink} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail ? <Text numberOfLines={1} style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      <Ionicons name={actionIcon} size={18} color={mockColors.muted} />
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
    paddingVertical: 10,
    fontFamily: mockFonts.body,
    fontSize: 15,
    color: mockColors.ink,
  },
  tile: {
    width: "31.5%",
    aspectRatio: 0.9,
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 18,
    padding: 12,
    backgroundColor: mockColors.surface,
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
    backgroundColor: mockColors.soft,
  },
  tileGlyphAccent: {
    backgroundColor: mockColors.surface,
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
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    borderWidth: 1,
    borderColor: mockColors.line,
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 10,
    backgroundColor: mockColors.surface,
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
    marginTop: 3,
    fontFamily: mockFonts.body,
    fontSize: 12,
    color: mockColors.muted,
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.985 }],
  },
});
