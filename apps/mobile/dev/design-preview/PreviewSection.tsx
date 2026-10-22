import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { SectionLabel } from "@/components/ui";

export function PreviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <SectionLabel>{title}</SectionLabel>
      {children}
    </View>
  );
}

/** Items side by side, wrapping onto further lines. */
export function PreviewRow({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

export function PreviewCaption({ children }: { children: string }) {
  return <Text style={styles.caption}>{children}</Text>;
}

/** Lets a full-width component reach the screen edges through the gallery's margin. */
export function PreviewBleed({ children }: { children: ReactNode }) {
  return <View style={styles.bleed}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.v2.space[12],
    paddingBottom: theme.v2.space[24],
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.v2.space[8],
  },
  caption: {
    ...theme.v2.text.footnote,
    color: theme.v2.colors.textSubtle,
  },
  bleed: {
    marginHorizontal: -theme.v2.space[20],
  },
}));
