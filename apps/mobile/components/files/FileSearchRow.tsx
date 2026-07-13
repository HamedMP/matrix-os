import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { isImageFile, type MatrixFileSearchResult } from "@/lib/matrix-files";

function iconForResult(result: MatrixFileSearchResult): keyof typeof Ionicons.glyphMap {
  if (result.type === "directory") return "folder";
  if (isImageFile(result.name)) return "image-outline";
  return "document-text-outline";
}

export const FileSearchRow = memo(function FileSearchRow({
  result,
  onPress,
}: {
  result: MatrixFileSearchResult;
  onPress: (result: MatrixFileSearchResult) => void;
}) {
  const { theme } = useUnistyles();
  const contentMatch = result.matches.find((match) => match.type === "content");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${result.path}`}
      onPress={() => onPress(result)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.iconWrap}>
        <Ionicons
          name={iconForResult(result)}
          size={18}
          color={result.type === "directory" ? theme.colors.primary : theme.colors.mutedForeground}
        />
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {result.name}
        </Text>
        <Text style={styles.path} numberOfLines={1}>
          {result.path}
        </Text>
        {contentMatch ? (
          <Text style={styles.snippet} numberOfLines={1}>
            {contentMatch.line ? `${contentMatch.line}: ` : ""}
            {contentMatch.text}
          </Text>
        ) : null}
      </View>
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
    width: 34,
    height: 34,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
  body: { flex: 1, minWidth: 0 },
  name: { fontFamily: theme.fonts.sansSemiBold, fontSize: 15, color: theme.colors.foreground },
  path: { marginTop: 2, fontFamily: theme.fonts.mono, fontSize: 11, color: theme.colors.mutedForeground },
  snippet: { marginTop: 2, fontFamily: theme.fonts.mono, fontSize: 11, color: theme.colors.primary },
}));
