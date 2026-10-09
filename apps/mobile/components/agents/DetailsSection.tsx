import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { SectionLabel } from "@/components/ui";

export interface DetailsSectionProps {
  label: string;
  children: ReactNode;
  /** Why the last change in this section did not go through, in plain words. */
  error?: string | null;
  testID?: string;
}

/** A labelled card of rows in the agent details sheet. */
export function DetailsSection({ label, children, error, testID }: DetailsSectionProps) {
  return (
    <View testID={testID} style={styles.section}>
      <SectionLabel>{label}</SectionLabel>
      {children}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The rows bring 10pt above and below themselves, so the card adds only 4 at the bottom.
  section: {
    borderRadius: theme.v2.radius.field,
    paddingTop: theme.v2.space[10],
    paddingHorizontal: theme.v2.space[14],
    paddingBottom: theme.v2.space[4],
    backgroundColor: theme.v2.colors.card,
  },
  error: {
    ...theme.v2.text.label,
    paddingBottom: theme.v2.space[10],
    color: theme.v2.colors.danger,
  },
}));
