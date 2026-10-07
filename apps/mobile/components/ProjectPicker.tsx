import { View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { MenuPicker } from "@/components/ui/MenuPicker";
import type { ProjectSummary } from "@/lib/requests";

const NO_PROJECT_VALUE = "";
// The trigger sits on its own row above the composer, so its label may take
// most of the window before it is cut off.
const LABEL_WIDTH_SHARE = 0.6;

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
  const { width } = useWindowDimensions();
  if (projects.length === 0) return null;

  function handleChange(value: string) {
    onSelectionChange(value === NO_PROJECT_VALUE ? null : value);
  }

  return (
    <View style={styles.row}>
      <MenuPicker
        options={[
          { label: "No project", value: NO_PROJECT_VALUE },
          ...projects.map((project) => ({ label: projectLabel(project), value: project.id })),
        ]}
        selectedValue={selectedProjectId ?? NO_PROJECT_VALUE}
        onValueChange={handleChange}
        accessibilityLabel="Project"
        maxLabelWidth={Math.round(width * LABEL_WIDTH_SHARE)}
        testID="project-picker"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
});
