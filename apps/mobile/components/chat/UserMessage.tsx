import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/** What the person sent: a bubble against the right edge. */
export function UserMessage({ text }: { text: string }) {
  return (
    <View testID="user-message" style={styles.bubble}>
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bubble: {
    maxWidth: "80%",
    alignSelf: "flex-end",
    borderRadius: theme.v2.radius.bubble,
    paddingHorizontal: theme.v2.space[14],
    paddingVertical: theme.v2.space[10],
    backgroundColor: theme.v2.colors.card,
  },
  text: {
    ...theme.v2.text.callout,
    color: theme.v2.colors.textDefault,
  },
}));
