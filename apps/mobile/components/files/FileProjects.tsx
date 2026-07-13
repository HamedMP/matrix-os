import { Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { MatrixProject } from "@/lib/matrix-files";

export function FileProjects({
  projects,
  onOpen,
}: {
  projects: MatrixProject[];
  onOpen: (project: MatrixProject) => void;
}) {
  const { theme } = useUnistyles();
  if (projects.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>Projects</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {projects.map((project) => (
          <Pressable
            key={project.path}
            accessibilityRole="button"
            accessibilityLabel={`Open project ${project.name}`}
            onPress={() => onOpen(project)}
            style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
          >
            <View style={styles.chipHeader}>
              <Ionicons name="git-branch-outline" size={14} color={theme.colors.primary} />
              <Text style={styles.chipName} numberOfLines={1}>
                {project.name}
              </Text>
            </View>
            <Text style={styles.chipMeta} numberOfLines={1}>
              {project.branch ?? "no branch"}
              {project.dirtyCount > 0 ? ` · ${project.dirtyCount} changed` : ""}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing.sm },
  sectionLabel: {
    fontFamily: theme.fonts.monoBold,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: theme.colors.mutedForeground,
    paddingHorizontal: 2,
  },
  row: { gap: theme.spacing.sm, paddingRight: theme.spacing.md },
  chip: {
    minWidth: 150,
    maxWidth: 220,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    gap: 4,
  },
  chipPressed: { opacity: 0.82, transform: [{ scale: 0.99 }] },
  chipHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  chipName: { flex: 1, fontFamily: theme.fonts.sansSemiBold, fontSize: 14, color: theme.colors.foreground },
  chipMeta: { fontFamily: theme.fonts.mono, fontSize: 11, color: theme.colors.mutedForeground },
}));
