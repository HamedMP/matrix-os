import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { StatusDot } from "@/components/ui";

export interface InteractionCardProps {
  /** What the agent is waiting for, beside the waiting dot. */
  label: string;
  title?: string;
  children?: ReactNode;
  /** Why the last answer did not go through, in plain words. Drawn last. */
  error?: string | null;
  testID?: string;
}

/** The outlined card an agent's request to the person is drawn in. */
export function InteractionCard({ label, title, children, error, testID }: InteractionCardProps) {
  return (
    <View testID={testID} style={styles.card}>
      <View testID={testID ? `${testID}-label` : undefined} style={styles.labelRow}>
        <StatusDot tone="waiting" />
        <Text style={styles.label}>{label}</Text>
      </View>
      {title ? <Text accessibilityRole="header" style={styles.title}>{title}</Text> : null}
      {children}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  );
}

/** A line of explanation inside a card. */
export function InteractionNote({ children }: { children: string }) {
  return <Text style={styles.note}>{children}</Text>;
}

/** What an agent asks to do with a service, in the words every surface shares. */
export interface RequestedAccess {
  summary: string;
  /** What stays untouched, when the access is narrow enough to say so. */
  boundary: string | null;
}

/** The access an agent asks for, shown before the person agrees to it. */
export function RequestedAccessNotes({ access }: { access: RequestedAccess }) {
  return (
    <>
      <InteractionNote>{`Requested access: ${access.summary}`}</InteractionNote>
      {access.boundary ? <InteractionNote>{access.boundary}</InteractionNote> : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.v2.space[12],
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.colors.highlight,
    borderRadius: theme.v2.radius.modal,
    padding: theme.v2.space[16],
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
  },
  label: {
    ...theme.v2.text.footnoteMedium,
    color: theme.v2.colors.textSubtle,
  },
  title: {
    ...theme.v2.text.calloutSemiBold,
    color: theme.v2.colors.textDefault,
  },
  note: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
  },
  error: {
    ...theme.v2.text.label,
    color: theme.v2.colors.danger,
  },
}));
