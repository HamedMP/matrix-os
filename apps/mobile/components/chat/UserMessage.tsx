import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { ChatContextMenu } from "@/components/ChatContextMenu";
import { AlertIcon, Icon } from "@/components/ui";
import { DISABLED_OPACITY, PRESSED_OPACITY } from "@/components/ui/pressable-state";
import type { TranscriptAttachment } from "@/lib/chat-attachments";

import { MessageAttachments, type MessageAttachmentsProps } from "./MessageAttachments";
import { Spinner } from "./Spinner";

// A send that is in by then says nothing, so a quick one never flickers a note.
const SENDING_NOTE_DELAY_MS = 1_000;
const STATUS_ICON_SIZE = 14;
const SENDING_SPINNER_SIZE = 12;
// The status actions are short words on a short line; this brings each to a full tap target.
const ACTION_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 } as const;

export interface UserMessageProps extends Pick<MessageAttachmentsProps, "renderComputerPhoto"> {
  text: string;
  /** The photos and files sent with it, shown above the text. */
  attachments?: readonly TranscriptAttachment[];
  /** The chat the bubble's long-press menu offers to copy the ID of. */
  chatId?: string | null;
  /**
   * Where a message sent from this phone is, said under it: "sending" once a
   * send takes a while, "failed" when it was not sent. Left out once the
   * computer has it.
   */
  delivery?: "sending" | "failed";
  /** Sends a message that was not sent again. Not offered when left out. */
  onRetry?: () => void;
  /** Takes a message that was not sent back into the composer. Not offered when left out. */
  onEdit?: () => void;
  /** The message cannot be sent again right now; it can still be edited. */
  retryDisabled?: boolean;
}

/** What the person sent: a bubble against the right edge, under anything sent with it. */
export function UserMessage({
  text,
  attachments,
  chatId,
  renderComputerPhoto,
  delivery,
  onRetry,
  onEdit,
  retryDisabled = false,
}: UserMessageProps) {
  const content = !attachments || attachments.length === 0 ? <Bubble text={text} chatId={chatId} /> : (
    <View testID="user-message-with-attachments" style={styles.group}>
      <MessageAttachments attachments={attachments} renderComputerPhoto={renderComputerPhoto} />
      {text ? <Bubble text={text} chatId={chatId} /> : null}
    </View>
  );
  if (!delivery) return content;
  return (
    <View style={styles.group}>
      {content}
      {delivery === "failed"
        ? <UnsentStatus onRetry={onRetry} onEdit={onEdit} retryDisabled={retryDisabled} />
        : <SendingStatus />}
    </View>
  );
}

function Bubble({ text, chatId }: { text: string; chatId?: string | null }) {
  const { theme } = useUnistyles();

  return (
    // A long press lifts the bubble alone, with its own corners.
    <ChatContextMenu
      chatId={chatId}
      messageText={text}
      fit="end"
      cornerRadius={theme.v2.radius.bubble}
    >
      <Pressable accessible={false} testID="user-message" style={styles.bubble}>
        <Text style={styles.text}>{text}</Text>
      </Pressable>
    </ChatContextMenu>
  );
}

/** "Sending…" under a message whose send is taking a while. */
function SendingStatus() {
  const { theme } = useUnistyles();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), SENDING_NOTE_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <View testID="user-message-sending" style={styles.status}>
      <Spinner size={SENDING_SPINNER_SIZE} color={theme.v2.colors.textTertiary} />
      <Text style={styles.sendingText}>Sending…</Text>
    </View>
  );
}

/** "Not sent" under a message whose send failed, with what can be done about it. */
function UnsentStatus({ onRetry, onEdit, retryDisabled }: Pick<UserMessageProps, "onRetry" | "onEdit" | "retryDisabled">) {
  const { theme } = useUnistyles();
  return (
    <View testID="user-message-unsent" style={styles.status}>
      <Icon icon={AlertIcon} size={STATUS_ICON_SIZE} color={theme.v2.colors.danger} />
      <Text accessibilityRole="alert" style={styles.unsentText}>Not sent</Text>
      {onRetry ? (
        <StatusAction label="Retry" accessibilityLabel="Retry sending" onPress={onRetry} disabled={retryDisabled} />
      ) : null}
      {onEdit ? <StatusAction label="Edit" accessibilityLabel="Edit message" onPress={onEdit} /> : null}
    </View>
  );
}

function StatusAction({
  label,
  accessibilityLabel,
  onPress,
  disabled = false,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={ACTION_HIT_SLOP}
      onPress={onPress}
      style={({ pressed }) => [disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  // As wide as the list, so the bubble's and the attachments' widths are
  // shares of the same thing with and without each other.
  group: {
    alignItems: "flex-end",
    gap: theme.v2.space[6],
  },
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
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
    paddingHorizontal: theme.v2.space[2],
  },
  sendingText: {
    ...theme.v2.text.footnote,
    color: theme.v2.colors.textTertiary,
  },
  unsentText: {
    ...theme.v2.text.footnote,
    color: theme.v2.colors.danger,
  },
  actionText: {
    ...theme.v2.text.footnoteMedium,
    color: theme.v2.colors.textDefault,
    paddingLeft: theme.v2.space[6],
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
