import { Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { RuntimeSummary } from "@matrix-os/contracts";

type ProjectSummary = RuntimeSummary["projects"]["items"][number];

type AgentProjectPickerProps = {
  projects: ProjectSummary[];
  selectedProjectId?: string;
  taskId?: string;
  pickerOpen: boolean;
  mode: "scratch" | "github";
  input: string;
  createStatus: "idle" | "submitting";
  createError: string | null;
  onTogglePicker: () => void;
  onChooseProject: (projectId: string) => void;
  onModeChange: (mode: "scratch" | "github") => void;
  onInputChange: (value: string) => void;
  onCreate: () => void;
};

export function AgentProjectPicker({
  projects,
  selectedProjectId,
  taskId,
  pickerOpen,
  mode,
  input,
  createStatus,
  createError,
  onTogglePicker,
  onChooseProject,
  onModeChange,
  onInputChange,
  onCreate,
}: AgentProjectPickerProps) {
  const { theme } = useUnistyles();
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const hasAvailableProjects = projects.some((project) => project.status === "available");

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Project</Text>
      {hasAvailableProjects ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Project ${selectedProject?.label ?? "None"}`}
            onPress={onTogglePicker}
            style={styles.projectButton}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{selectedProject?.label ?? "Choose project"}</Text>
              <Text style={styles.rowSubtitle}>{taskId ? `Task chat · ${taskId}` : "Project chat"}</Text>
            </View>
            <Ionicons name={pickerOpen ? "chevron-up" : "chevron-down"} size={18} color={theme.colors.moss} />
          </Pressable>
          {pickerOpen ? (
            <View accessibilityLabel="Project picker" style={styles.pickerSheet}>
              {projects.map((project) => (
                <Pressable
                  key={project.id}
                  accessibilityRole="button"
                  accessibilityLabel={project.label}
                  disabled={project.status !== "available"}
                  onPress={() => onChooseProject(project.id)}
                  style={[
                    styles.projectOption,
                    project.id === selectedProject?.id && styles.projectOptionActive,
                    project.status !== "available" && styles.projectOptionDisabled,
                  ]}
                >
                  <Text style={styles.rowTitle}>{project.label}</Text>
                  <Text style={styles.rowSubtitle}>{project.status}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </>
      ) : (
        <View style={styles.emptyState}>
          <Ionicons name="folder-open-outline" size={24} color={theme.colors.moss} />
          <Text style={styles.emptyTitle}>Create or import a project first</Text>
          <Text style={styles.emptyBody}>Every new chat belongs to a project on this Matrix computer.</Text>
          <View style={styles.modeRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create scratch project"
              onPress={() => onModeChange("scratch")}
              style={[styles.modeButton, mode === "scratch" && styles.modeButtonActive]}
            >
              <Text style={[styles.modeText, mode === "scratch" && styles.modeTextActive]}>New project</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Import GitHub project"
              onPress={() => onModeChange("github")}
              style={[styles.modeButton, mode === "github" && styles.modeButtonActive]}
            >
              <Text style={[styles.modeText, mode === "github" && styles.modeTextActive]}>Import GitHub</Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel={mode === "scratch" ? "New project name" : "GitHub repository URL"}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={mode === "scratch" ? 128 : 512}
            value={input}
            onChangeText={onInputChange}
            placeholder={mode === "scratch" ? "Project name" : "https://github.com/owner/repository"}
            placeholderTextColor={theme.colors.mutedForeground}
            style={styles.projectInput}
          />
          {createError ? <Text selectable style={styles.errorText}>{createError}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mode === "scratch" ? "Create project" : "Import project"}
            disabled={createStatus === "submitting"}
            onPress={onCreate}
            style={[styles.createButton, createStatus === "submitting" && styles.createButtonDisabled]}
          >
            <Text style={styles.createButtonText}>
              {createStatus === "submitting" ? "Creating" : mode === "scratch" ? "Create project" : "Import project"}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing.sm },
  sectionTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 14,
    color: theme.colors.foreground,
  },
  projectButton: {
    minHeight: 62,
    borderRadius: 14,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  pickerSheet: {
    borderRadius: 16,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    overflow: "hidden",
  },
  projectOption: {
    padding: theme.spacing.md,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  projectOptionActive: { backgroundColor: theme.colors.secondary },
  projectOptionDisabled: { opacity: 0.5 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  rowSubtitle: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.mutedForeground,
    textTransform: "capitalize",
  },
  emptyState: {
    borderRadius: 18,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    backgroundColor: theme.colors.card,
  },
  emptyTitle: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 16,
    color: theme.colors.foreground,
  },
  emptyBody: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    color: theme.colors.mutedForeground,
  },
  modeRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm },
  modeButton: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.card,
  },
  modeButtonActive: { backgroundColor: theme.colors.forest, borderColor: theme.colors.forest },
  modeText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  modeTextActive: { color: theme.colors.background },
  projectInput: {
    minHeight: 48,
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.background,
    fontFamily: theme.fonts.sans,
    fontSize: 15,
  },
  errorText: {
    fontFamily: theme.fonts.sansMedium,
    fontSize: 13,
    color: theme.colors.destructive,
  },
  createButton: {
    minHeight: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.forest,
  },
  createButtonDisabled: { opacity: 0.56 },
  createButtonText: {
    fontFamily: theme.fonts.sansSemiBold,
    fontSize: 14,
    color: theme.colors.background,
  },
}));
