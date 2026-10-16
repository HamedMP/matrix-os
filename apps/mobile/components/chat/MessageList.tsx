import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FlatList, Text, type ListRenderItemInfo } from "react-native";
import Animated from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";

import { AnalyticsMask } from "@/lib/analytics";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";
import { useReduceMotion } from "@/lib/use-reduce-motion";

import { AssistantMessage } from "./AssistantMessage";
import { messageEntering, messageEnteringReduced } from "./message-motion";
import { createSeenMessages, type SeenMessages } from "./seen-messages";
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

/** Still arriving: sent from this phone and on its way, or a reply being written. Only these animate in. */
const isArriving = (message: TranscriptMessage) =>
  message.delivery === "sending" || (message.role === "assistant" && message.isRunning);

/** A chat's messages, newest at the bottom. */
export function MessageList({
  messages,
  chatId,
  renderRequest,
  renderResults,
  renderComputerPhoto,
  footer,
}: MessageListProps) {
  const reduceMotion = useReduceMotion();
  const entering = reduceMotion ? messageEnteringReduced : messageEntering;
  const [seen] = useState(createSeenMessages);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<TranscriptMessage>) => (
    <MessageMotion id={item.id} arriving={isArriving(item)} seen={seen} entering={entering}>
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
    </MessageMotion>
  ), [chatId, renderRequest, renderResults, renderComputerPhoto, entering, seen]);

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

/**
 * Lets an arriving message rise in the first time it is drawn. The list lets
 * rows far from view go and draws them again on the way back; a reply still
 * being written then holds still instead of entering again.
 */
function MessageMotion({
  id,
  arriving,
  seen,
  entering,
  children,
}: {
  id: string;
  arriving: boolean;
  seen: SeenMessages;
  entering: typeof messageEntering | typeof messageEnteringReduced;
  children: ReactNode;
}) {
  // Decided once, as the row is first drawn.
  const [enters] = useState(() => arriving && !seen.has(id));
  useEffect(() => {
    if (arriving) seen.add(id);
  }, [arriving, seen, id]);

  return (
    <Animated.View testID={`message-motion-${id}`} entering={enters ? entering : undefined}>
      {children}
    </Animated.View>
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
