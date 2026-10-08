import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { ChatToolActivity, ChatToolCallLine } from "@/components/ChatToolActivity";
import { DisclosureDownIcon, Icon } from "@/components/ui";
import { PRESSED_OPACITY } from "@/components/ui/pressable-state";
import { transcriptWorkLabel, type TranscriptMessage } from "@/lib/canonical-chat-transcript";

// The design draws up to five steps open; a longer run folds behind its time label.
const ALWAYS_VISIBLE_STEPS = 5;
const TOGGLE_ICON_SIZE = 14;

/** What the agent did for a reply, one line per step. */
export function StepsBlock({ message }: { message: TranscriptMessage }) {
  // Open while the turn runs and closed once it is done, until the person toggles it.
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const { theme } = useUnistyles();

  const covered = message.activities.map((activity) => activity.id);
  const toolCalls = message.toolCalls.filter((call) => !covered.includes(call.id));
  const stepCount = message.activities.length + toolCalls.length;

  if (stepCount === 0) {
    // A turn can work for a while before it has a step or a word to show.
    if (!message.isRunning || message.text) return null;
    return (
      <View testID="steps-block" style={styles.block}>
        <ChatToolActivity activity={{ id: message.id, kind: "phase", state: "running", label: "Working…" }} />
      </View>
    );
  }

  const foldable = stepCount > ALWAYS_VISIBLE_STEPS;
  const expanded = !foldable || (manualExpanded ?? message.isRunning);

  return (
    <View style={styles.steps}>
      {foldable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Hide work" : "Show work"}
          accessibilityState={{ expanded }}
          onPress={() => setManualExpanded(!expanded)}
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
        >
          <Text style={styles.toggleText}>{transcriptWorkLabel(message)}</Text>
          <View style={expanded && styles.toggleIconOpen}>
            <Icon icon={DisclosureDownIcon} size={TOGGLE_ICON_SIZE} color={theme.v2.colors.textSubtle} />
          </View>
        </Pressable>
      ) : null}
      {expanded ? (
        <View testID="steps-block" style={styles.block}>
          {message.activities.map((activity) => <ChatToolActivity key={activity.id} activity={activity} />)}
          {toolCalls.map((call) => <ChatToolCallLine key={call.id} label={call.label} />)}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  steps: {
    alignSelf: "stretch",
  },
  block: {
    alignSelf: "stretch",
    gap: theme.v2.space[8],
    borderRadius: theme.v2.radius.field,
    paddingHorizontal: theme.v2.space[14],
    paddingVertical: theme.v2.space[12],
    backgroundColor: theme.v2.colors.card,
  },
  toggle: {
    minHeight: theme.v2.size.tapTarget,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
  },
  toggleText: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
  },
  toggleIconOpen: {
    transform: [{ rotate: "180deg" }],
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
