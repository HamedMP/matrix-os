import { useCallback, type ReactNode } from "react";
import { FlatList, Text, type ListRenderItemInfo } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { AnalyticsMask } from "@/lib/analytics";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";

import { AssistantMessage } from "./AssistantMessage";
import type { MessageAttachmentsProps } from "./MessageAttachments";
import { useUnsentMessageActions } from "./unsent-message-actions";
import { UserMessage } from "./UserMessage";

export interface MessageListProps extends Pick<MessageAttachmentsProps, "renderComputerPhoto"> {
  /** Newest first: the list is drawn from the bottom up. */
  messages: TranscriptMessage[];
  /** The chat a message's long-press menu offers to copy the ID of. None for a chat that does not exist yet. */
  chatId?: string | null;
  /** Draws a message that asks the person something, in place of its text. Null for any other message. */
  renderRequest?: (message: TranscriptMessage) => ReactNode;
  /** Draws what belongs under a reply, such as its result cards. */
  renderResults?: (message: TranscriptMessage) => ReactNode;
  /** Drawn after the newest message, such as what an agent is waiting on the person for. */
  footer?: ReactNode;
}

const keyExtractor = (message: TranscriptMessage) => message.id;

/** A chat's messages, newest at the bottom. */
export function MessageList({
  messages,
  chatId,
  renderRequest,
  renderResults,
  renderComputerPhoto,
  footer,
}: MessageListProps) {
  const renderItem = useCallback(({ item }: ListRenderItemInfo<TranscriptMessage>) => (
    <AnalyticsMask>
      {renderRequest?.(item) ?? (
        <Message
          message={item}
          chatId={chatId}
          renderResults={renderResults}
          renderComputerPhoto={renderComputerPhoto}
        />
      )}
    </AnalyticsMask>
  ), [chatId, renderRequest, renderResults, renderComputerPhoto]);

  return (
    <FlatList
      style={styles.list}
      data={messages}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      inverted
      // The list is drawn from the bottom up, so its header is what comes last.
      ListHeaderComponent={footer ? <AnalyticsMask>{footer}</AnalyticsMask> : null}
      // In a chat that exists, a tap on the messages closes the keyboard. One
      // that is still being created shows only what was just sent, and a tap
      // there goes to whatever it lands on.
      keyboardShouldPersistTaps={chatId ? "never" : "handled"}
      contentContainerStyle={styles.content}
    />
  );
}

function Message({
  message,
  chatId,
  renderResults,
  renderComputerPhoto,
}: Pick<MessageListProps, "chatId" | "renderResults" | "renderComputerPhoto"> & { message: TranscriptMessage }) {
  // A message that was not sent offers what the chat it is shown in can do about it.
  const unsent = useUnsentMessageActions();
  if (message.role === "user") {
    const failed = message.delivery === "failed" && unsent !== null;
    return (
      <UserMessage
        text={message.text}
        attachments={message.attachments}
        chatId={chatId}
        renderComputerPhoto={renderComputerPhoto}
        delivery={message.delivery}
        onRetry={failed ? () => unsent.onRetry(message.id) : undefined}
        onEdit={failed ? () => unsent.onEdit(message.id) : undefined}
        retryDisabled={message.retryBlocked}
      />
    );
  }
  if (message.role === "assistant") {
    return <AssistantMessage message={message} chatId={chatId} results={renderResults?.(message)} />;
  }
  return (
    <Text style={[styles.note, message.role === "system" && styles.noteCentred]}>{message.text}</Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
  },
  content: {
    gap: theme.v2.space[14],
    paddingHorizontal: theme.v2.space[20],
    paddingVertical: theme.v2.space[20],
  },
  note: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
  },
  noteCentred: {
    textAlign: "center",
  },
}));
