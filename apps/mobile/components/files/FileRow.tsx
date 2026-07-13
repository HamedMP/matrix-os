import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  formatFileSize,
  formatRelativeTime,
  isImageFile,
  type MatrixFileEntry,
} from "@/lib/matrix-files";

function iconForEntry(entry: MatrixFileEntry): keyof typeof Ionicons.glyphMap {
  if (entry.type === "directory") return "folder";
  if (isImageFile(entry.name)) return "image-outline";
  return "document-text-outline";
}

function metaForEntry(entry: MatrixFileEntry, nowMs: number): string {
  const parts: string[] = [];
  if (entry.type === "directory") {
    if (typeof entry.children === "number") {
      parts.push(`${entry.children} ${entry.children === 1 ? "item" : "items"}`);
    }
  } else if (typeof entry.size === "number") {
    const size = formatFileSize(entry.size);
    if (size) parts.push(size);
  }
  const age = formatRelativeTime(entry.modified, nowMs);
  if (age) parts.push(age);
  return parts.join(" · ");
}

export const FileRow = memo(function FileRow({
  entry,
  nowMs,
  onPress,
}: {
  entry: MatrixFileEntry;
  nowMs: number;
  onPress: (entry: MatrixFileEntry) => void;
}) {
  const { theme } = useUnistyles();
  const meta = metaForEntry(entry, nowMs);
  const changed = entry.type === "directory" && typeof entry.changedCount === "number" && entry.changedCount > 0;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${entry.name}`}
      onPress={() => onPress(entry)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.iconWrap}>
        <Ionicons
          name={iconForEntry(entry)}
          size={20}
          color={entry.type === "directory" ? theme.colors.primary : theme.colors.mutedForeground}
        />
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {entry.name}
        </Text>
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {entry.gitStatus ? <Text style={styles.gitBadge}>{entry.gitStatus}</Text> : null}
      {changed ? <Text style={styles.changedBadge}>{entry.changedCount}</Text> : null}
      {entry.type === "directory" ? (
        <Ionicons name="chevron-forward" size={16} color={theme.colors.mutedForeground} />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  rowPressed: { opacity: 0.82, transform: [{ scale: 0.99 }] },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  body: { flex: 1, minWidth: 0 },
  name: { fontFamily: theme.fonts.sansSemiBold, fontSize: 15, color: theme.colors.foreground },
  meta: { marginTop: 2, fontFamily: theme.fonts.mono, fontSize: 11, color: theme.colors.mutedForeground },
  gitBadge: {
    overflow: "hidden",
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
    fontFamily: theme.fonts.sansMedium,
    fontSize: 10,
    color: theme.colors.primary,
    backgroundColor: theme.colors.secondary,
    textTransform: "capitalize",
  },
  changedBadge: {
    minWidth: 20,
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
    textAlign: "center",
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.primary,
    backgroundColor: theme.colors.secondary,
  },
}));
