import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button, Chip, Sheet, Spacer, Text } from "@/components/ui";

export interface NotificationChoice {
  title: string;
  options: readonly { value: string | number; label: string }[];
  value: string | number;
  choose: (value: string | number) => void;
}
export function NotificationChoiceSheet({ choice, close }: { choice: NotificationChoice | null; close: () => void }) {
  return (
    <Sheet visible={choice !== null} onClose={close} testID="notification-choice-sheet">
      {choice ? <View style={styles.content}>
        <Text accessibilityRole="header">{choice.title}</Text>
        <Spacer size="lg" />
        <View style={styles.options}>
          {choice.options.map((option) => <Chip key={option.value} label={option.label}
            selected={choice.value === option.value} onPress={() => { choice.choose(option.value); close(); }} />)}
        </View>
        <Spacer size="lg" />
        <Button variant="text" label="Close options" onPress={close} />
      </View> : null}
    </Sheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.v2.space[20] },
  options: { flexDirection: "row", flexWrap: "wrap", gap: theme.v2.space[12] },
}));
