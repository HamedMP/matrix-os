import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { ChatContextMenu } from "@/components/ChatContextMenu";
import type { TranscriptAttachment } from "@/lib/chat-attachments";

import { MessageAttachments, type MessageAttachmentsProps } from "./MessageAttachments";

export interface UserMessageProps extends Pick<MessageAttachmentsProps, "renderComputerPhoto"> {
  text: string;
  /** The photos and files sent with it, shown above the text. */
  attachments?: readonly TranscriptAttachment[];
  /** The chat the bubble's long-press menu offers to copy the ID of. */
  chatId?: string | null;
}

/** What the person sent: a bubble against the right edge, under anything sent with it. */
export function UserMessage({ text, attachments, chatId, renderComputerPhoto }: UserMessageProps) {
  if (!attachments || attachments.length === 0) return <Bubble text={text} chatId={chatId} />;
  return (
    <View testID="user-message-with-attachments" style={styles.group}>
      <MessageAttachments attachments={attachments} renderComputerPhoto={renderComputerPhoto} />
      {text ? <Bubble text={text} chatId={chatId} /> : null}
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
}));
