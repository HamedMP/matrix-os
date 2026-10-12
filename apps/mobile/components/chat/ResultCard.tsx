import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { AppsTabIcon, Button, IconTile } from "@/components/ui";

import type { ChatResultApp } from "./types";

export interface ResultCardProps {
  app: ChatResultApp;
  onOpen: (app: ChatResultApp) => void;
}

/** An app a reply produced or refers to, with a way to open it. */
export function ResultCard({ app, onOpen }: ResultCardProps) {
  return (
    <View testID="result-card" style={styles.card}>
      <IconTile icon={AppsTabIcon} size={36} tone="subtle" />
      <View style={styles.text}>
        <Text numberOfLines={1} style={styles.name}>{app.name}</Text>
        <Text numberOfLines={1} style={styles.detail}>{app.detail}</Text>
      </View>
      <Button
        variant="outline"
        label="Open"
        accessibilityLabel={`Open ${app.name}`}
        onPress={() => onOpen(app)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[12],
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.colors.borderHairline,
    borderRadius: theme.v2.radius.field,
    paddingHorizontal: theme.v2.space[14],
    paddingVertical: theme.v2.space[12],
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    ...theme.v2.text.labelMedium,
    color: theme.v2.colors.textDefault,
  },
  detail: {
    ...theme.v2.text.footnote,
    color: theme.v2.colors.textSubtle,
  },
}));
