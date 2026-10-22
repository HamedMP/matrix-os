import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { RabbitMark } from "@/components/ui";
import { PRESSED_OPACITY } from "@/components/ui/pressable-state";

export interface ChatHomeProps {
  suggestions: readonly string[];
  onSuggestionPress: (suggestion: string) => void;
}

/** What a new chat shows before its first message: the greeting and a few starters. */
export function ChatHome({ suggestions, onSuggestionPress }: ChatHomeProps) {
  return (
    <ScrollView
      testID="chat-home"
      style={styles.scroll}
      contentContainerStyle={styles.content}
      // A suggestion takes its tap even with the keyboard open; a tap anywhere
      // else closes the keyboard, which is what brings the tabs back.
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.mark}>
        <RabbitMark />
      </View>
      <Text accessibilityRole="header" style={styles.heading}>What should we work on?</Text>
      <View testID="chat-home-suggestions" style={styles.suggestions}>
        {suggestions.map((suggestion) => (
          <Pressable
            key={suggestion}
            accessibilityRole="button"
            accessibilityLabel={suggestion}
            onPress={() => onSuggestionPress(suggestion)}
            style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
          >
            <Text style={styles.suggestionText}>{suggestion}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    gap: theme.v2.space[16],
    paddingHorizontal: theme.v2.space[20],
    paddingVertical: theme.v2.space[20],
  },
  mark: {
    alignItems: "center",
  },
  heading: {
    ...theme.v2.text.heading,
    color: theme.v2.colors.textDefault,
    textAlign: "center",
  },
  suggestions: {
    gap: theme.v2.space[8],
    paddingTop: theme.v2.space[12],
  },
  suggestion: {
    minHeight: theme.v2.size.tapTarget,
    justifyContent: "center",
    borderRadius: theme.v2.radius.field,
    paddingHorizontal: theme.v2.space[16],
    paddingVertical: theme.v2.space[14],
    backgroundColor: theme.v2.colors.card,
  },
  suggestionText: {
    ...theme.v2.text.label,
    color: theme.v2.colors.textDefault,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
