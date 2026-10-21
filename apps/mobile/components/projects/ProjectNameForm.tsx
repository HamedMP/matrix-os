import { useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { SheetActionHeader, TextField } from "@/components/ui";

// The longest name the server accepts for a project.
const MAX_NAME_LENGTH = 128;

export interface ProjectNameFormProps {
  title: string;
  confirmLabel: string;
  /** The name the field opens with. The action stays unavailable until the name differs from it. */
  initialName?: string;
  saving: boolean;
  /** What to say under the field about the last attempt, when it failed. */
  failure?: string | null;
  /** Called with the name, without the space around it. */
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

/** What a sheet that names a project holds: Cancel, the title and the action over the name field. */
export function ProjectNameForm({
  title,
  confirmLabel,
  initialName = "",
  saving,
  failure,
  onSubmit,
  onCancel,
}: ProjectNameFormProps) {
  const [name, setName] = useState(initialName);
  const chosenName = name.trim();
  const canSubmit = chosenName !== "" && chosenName !== initialName.trim();

  const submit = () => {
    if (canSubmit && !saving) onSubmit(chosenName);
  };

  return (
    <View testID="project-name-form" style={styles.form}>
      <SheetActionHeader
        title={title}
        confirmLabel={confirmLabel}
        confirmDisabled={!canSubmit}
        confirmLoading={saving}
        onConfirm={submit}
        onCancel={onCancel}
      />
      <View testID="project-name-field" style={styles.field}>
        <TextField
          testID="project-name-input"
          placeholder="Project name"
          value={name}
          onChangeText={setName}
          autoFocus
          clearable
          maxLength={MAX_NAME_LENGTH}
          editable={!saving}
          returnKeyType="done"
          onSubmitEditing={submit}
        />
        {failure ? <Text accessibilityRole="alert" style={styles.failure}>{failure}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.v2.space[16],
    padding: theme.v2.space[16],
  },
  field: {
    gap: theme.v2.space[8],
  },
  failure: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.danger,
  },
}));
