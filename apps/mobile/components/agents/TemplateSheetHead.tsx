import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { AgentMascot, CloseIcon, IconButton } from "@/components/ui";

const MASCOT_SIZE = 48;
const CLOSE_ICON_SIZE = 20;

export interface TemplateSheetHeadProps {
  /** Decides the mascot's face. */
  id: string;
  name: string;
  /** Decides the mascot's colour. */
  category?: string;
  /** The line under the name. */
  caption?: string;
  onClose: () => void;
  testID?: string;
}

/** The head of a sheet over the gallery: the mascot, the name over one line of its own, and a close button. */
export function TemplateSheetHead({ id, name, category, caption, onClose, testID }: TemplateSheetHeadProps) {
  const { theme } = useUnistyles();

  return (
    <View testID={testID} style={styles.head}>
      <AgentMascot id={id} name={name} category={category} size={MASCOT_SIZE} />
      <View style={styles.headText}>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.name}>{name}</Text>
        {caption ? <Text numberOfLines={3} style={styles.caption}>{caption}</Text> : null}
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
  );
}

const styles = StyleSheet.create((theme) => ({
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
  caption: {
    ...theme.v2.text.caption,
    marginTop: theme.v2.space[2],
    color: theme.v2.colors.textSubtle,
  },
}));
