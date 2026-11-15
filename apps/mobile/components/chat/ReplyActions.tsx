import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { useChatMenuActions } from "@/components/chat-menu-actions";
import { CopyIcon, Icon, PressableScale, ShareIcon, type IconData } from "@/components/ui";
import { tapHaptic } from "@/lib/haptics";
import { size } from "@/lib/theme-v2";

export interface ReplyActionsProps {
  /** The finished reply's text, as Copy and Share hand it on. */
  text: string;
  /** When the reply was written, in milliseconds. */
  createdAt: number;
}

// "3:04 PM", or "15:04", as the phone's own clock writes times.
const replyTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Empty for a time that cannot be read. */
function formatReplyTime(createdAt: number): string {
  return Number.isFinite(createdAt) ? replyTime.format(createdAt) : "";
}

const BUTTON_SIZE = 32;
// A button drawn smaller than a fingertip still answers a press on its whole 44pt square.
const REACH = (size.tapTarget - BUTTON_SIZE) / 2;

/**
 * The row under a finished reply: Copy, Share and when it was written, as
 * Electron Desktop draws them under a turn's final reply. Copy and Share are
 * the long-press menu's own actions, so they behave the same from either place.
 */
export function ReplyActions({ text, createdAt }: ReplyActionsProps) {
  const actions = useChatMenuActions(null, text);
  const copy = actions.find((action) => action.id === "copy-text");
  const share = actions.find((action) => action.id === "share");
  const time = formatReplyTime(createdAt);

  return (
    <View testID="reply-actions" style={styles.row}>
      {copy ? (
        // The toast that says it was copied is felt as well as seen, so the press adds no tap of its own.
        <ReplyAction icon={CopyIcon} label="Copy reply" onPress={copy.onSelect} />
      ) : null}
      {share ? (
        <ReplyAction
          icon={ShareIcon}
          label="Share reply"
          onPress={() => {
            tapHaptic();
            share.onSelect();
          }}
        />
      ) : null}
      {time ? (
        <Text style={styles.time} accessibilityLabel={`Replied at ${time}`}>{time}</Text>
      ) : null}
    </View>
  );
}

function ReplyAction({ icon, label, onPress }: { icon: IconData; label: string; onPress: () => void }) {
  const { theme } = useUnistyles();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={REACH}
      onPress={onPress}
      style={styles.button}
    >
      <Icon icon={icon} size={18} color={theme.v2.colors.textSubtle} />
    </PressableScale>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[2],
    // The buttons' own room around their icons lines the first icon up with
    // the reply's text and keeps the row close under what comes before it.
    marginStart: -theme.v2.space[6],
    marginTop: -theme.v2.space[6],
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.v2.radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  time: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textTertiary,
    marginStart: theme.v2.space[6],
    fontVariant: ["tabular-nums"],
  },
}));
