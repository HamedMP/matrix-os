import { Host, Picker } from "@expo/ui";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import type { ProjectSummary } from "@/lib/requests";

const NO_PROJECT_VALUE = "";

function projectLabel(project: ProjectSummary): string {
  return project.kind === "github" && project.github
    ? `${project.name} (${project.github.owner}/${project.github.repo})`
    : project.name;
}

/**
 * Picks which Project a new chat starts in -- matches desktop's
 * ConversationContextPicker in effect (binds Chat.projectId, which becomes
 * the turn's executionRoot), but as a native menu like ModelPicker instead
 * of a bespoke popover, and scoped to chat creation only (see
 * use-send-chat-message.ts): an existing chat's project is set once at
 * creation and isn't repointed here.
 */
export function ProjectPicker({
  projects,
  selectedProjectId,
  onSelectionChange,
}: {
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  onSelectionChange: (projectId: string | null) => void;
}) {
  const { theme } = useUnistyles();
  if (projects.length === 0) return null;

  function handleChange(value: string) {
    onSelectionChange(value === NO_PROJECT_VALUE ? null : value);
  }

  return (
    <View style={styles.row}>
      <Host matchContents seedColor={theme.v2.appColors.muted}>
        <Picker
          appearance="menu"
          selectedValue={selectedProjectId ?? NO_PROJECT_VALUE}
          onValueChange={handleChange}
          testID="project-picker"
        >
          <Picker.Item label="No project" value={NO_PROJECT_VALUE} />
          {projects.map((project) => (
            <Picker.Item key={project.id} label={projectLabel(project)} value={project.id} />
          ))}
        </Picker>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
});
