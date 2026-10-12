import { useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  AgentMascot,
  Button,
  CloseIcon,
  IconButton,
  SectionLabel,
  Sheet,
  SheetGrabber,
  TextField,
} from "@/components/ui";

import type { AgentTemplate } from "./agent-templates";

const MASCOT_SIZE = 48;
const CLOSE_ICON_SIZE = 20;
// The longest name the server accepts for an agent.
const MAX_NAME_LENGTH = 80;

export interface TemplateSetupSheetProps {
  /** The template being set up. Null closes the sheet. */
  template: AgentTemplate | null;
  creating: boolean;
  /** The last attempt to create the agent failed. */
  failed: boolean;
  onCreate: (name: string) => void;
  onSetUpInChat: () => void;
  onClose: () => void;
}

/** The sheet over the template list: name the agent and create it. */
export function TemplateSetupSheet({ template, ...form }: TemplateSetupSheetProps) {
  // The template last chosen stays drawn while the sheet slides away, and
  // each opening starts a new form.
  const [shown, setShown] = useState({ current: template, drawn: template, opening: 0 });
  if (template !== shown.current) {
    setShown({
      current: template,
      drawn: template ?? shown.drawn,
      opening: template ? shown.opening + 1 : shown.opening,
    });
  }

  return (
    <Sheet visible={template !== null} onClose={form.onClose} testID="template-setup-sheet">
      {shown.drawn ? <TemplateSetupForm key={shown.opening} template={shown.drawn} {...form} /> : null}
    </Sheet>
  );
}

interface TemplateSetupFormProps extends Omit<TemplateSetupSheetProps, "template"> {
  template: AgentTemplate;
}

function TemplateSetupForm({ template, creating, failed, onCreate, onSetUpInChat, onClose }: TemplateSetupFormProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(template.name);
  const chosenName = name.trim();

  return (
    <View testID="template-setup" style={[styles.sheet, { paddingBottom: insets.bottom + theme.v2.space[10] }]}>
      <SheetGrabber testID="template-setup-grabber" />
      <View testID="template-setup-head" style={styles.head}>
        <AgentMascot id={template.recipeId} name={template.name} category={template.category} size={MASCOT_SIZE} />
        <View style={styles.headText}>
          <Text accessibilityRole="header" numberOfLines={1} style={styles.name}>{template.name}</Text>
          {template.description ? (
            <Text numberOfLines={3} style={styles.description}>{template.description}</Text>
          ) : null}
        </View>
        <IconButton
          accessibilityLabel="Close"
          icon={CloseIcon}
          iconSize={CLOSE_ICON_SIZE}
          iconColor={theme.v2.colors.textSubtle}
          buttonSize={theme.v2.size.tapTarget}
          borderRadius={theme.v2.radius.full}
          onPress={onClose}
        />
      </View>
      <SectionLabel>Name</SectionLabel>
      <View testID="template-setup-field" style={styles.field}>
        <TextField
          accessibilityLabel="Name"
          value={name}
          onChangeText={setName}
          maxLength={MAX_NAME_LENGTH}
          editable={!creating}
          returnKeyType="done"
        />
        {failed ? (
          <Text accessibilityRole="alert" style={styles.failure}>Agent could not be created. Try again.</Text>
        ) : null}
      </View>
      <View testID="template-setup-actions" style={styles.actions}>
        <Button
          size="large"
          fullWidth
          label="Create agent"
          disabled={!chosenName}
          loading={creating}
          onPress={() => onCreate(chosenName)}
        />
        <Button
          variant="text"
          size="large"
          fullWidth
          label="Set up in chat instead"
          disabled={creating}
          onPress={onSetUpInChat}
        />
      </View>
    </View>
  );
}

// The grabber brings the 10pt above it, so the sheet has no top padding.
const styles = StyleSheet.create((theme) => ({
  sheet: {
    gap: theme.v2.space[14],
    paddingHorizontal: theme.v2.space[20],
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[12],
  },
  headText: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    ...theme.v2.text.subheading,
    color: theme.v2.colors.textDefault,
  },
  description: {
    ...theme.v2.text.caption,
    marginTop: theme.v2.space[2],
    color: theme.v2.colors.textSubtle,
  },
  field: {
    gap: theme.v2.space[8],
  },
  failure: {
    ...theme.v2.text.label,
    color: theme.v2.colors.danger,
  },
  actions: {
    gap: theme.v2.space[4],
  },
}));
