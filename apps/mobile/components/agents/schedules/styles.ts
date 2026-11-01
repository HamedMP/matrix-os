import { StyleSheet } from "react-native-unistyles";

export const scheduleStyles = StyleSheet.create(theme => ({
  content: { padding: theme.v2.space[20], gap: theme.v2.space[16] },
  group: { gap: theme.v2.space[12] },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.v2.space[8] },
  title: { ...theme.v2.text.title, color: theme.v2.colors.textDefault },
  heading: { ...theme.v2.text.calloutSemiBold, color: theme.v2.colors.textDefault },
  text: { ...theme.v2.text.caption, color: theme.v2.colors.textDefault },
  note: { ...theme.v2.text.caption, color: theme.v2.colors.textSubtle },
  error: { ...theme.v2.text.caption, color: theme.v2.colors.danger },
  card: { padding: theme.v2.space[16], gap: theme.v2.space[12], borderRadius: theme.v2.radius.card, backgroundColor: theme.v2.colors.card },
  input: { ...theme.v2.text.callout, color: theme.v2.colors.textDefault, backgroundColor: theme.v2.colors.card,
    borderRadius: theme.v2.radius.field, padding: theme.v2.space[12], minHeight: 96, textAlignVertical: "top" },
}));
