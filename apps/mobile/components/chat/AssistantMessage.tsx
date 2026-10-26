import { useMemo, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { ChatContextMenu } from "@/components/ChatContextMenu";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";
import { renderChatMarkdown } from "@/lib/chat-markdown";
import { useStreamedTextReveal } from "@/lib/streamed-text-reveal";

import { chatMarkdownTheme } from "./chat-markdown-theme";
import { StepsBlock } from "./StepsBlock";
import { MermaidDiagram } from "./MermaidDiagram";

export interface AssistantMessageProps {
  message: TranscriptMessage;
  /** The chat the text's long-press menu offers to copy the ID of. */
  chatId?: string | null;
  /** What belongs under the reply, such as its result cards. */
  results?: ReactNode;
}

/** A reply: its text across the full width, then its steps, then its results. */
export function AssistantMessage({ message, chatId, results }: AssistantMessageProps) {
  const { theme } = useUnistyles();
  // While the reply streams, show it at a steady pace with each new chunk
  // fading in, rather than in the uneven bursts the network delivers.
  const reveal = useStreamedTextReveal(message.text, message.isRunning);
  // Re-parses on every text change, which is exactly what a growing streamed
  // string needs -- markdown applies as the text arrives, not once at the end.
  const markdownNodes = useMemo(
    () => renderChatMarkdown(reveal.text, chatMarkdownTheme(theme.v2), reveal.fades,
      (source, key) => <MermaidDiagram key={key} source={source} theme={chatMarkdownTheme(theme.v2)} />),
    [reveal.text, reveal.fades, theme],
  );

  return (
    <View testID="assistant-message" style={styles.message}>
      {message.text ? (
        // A long press lifts the text alone, not the steps and results under
        // it. The text is offered once the reply has finished.
        <ChatContextMenu
          chatId={chatId}
          messageText={message.isRunning ? null : message.text}
          cornerRadius={theme.v2.radius.card}
          inset={theme.v2.space[10]}
          backgroundColor={theme.v2.colors.background}
        >
          <Pressable accessible={false} testID="assistant-text" style={styles.text}>{markdownNodes}</Pressable>
        </ChatContextMenu>
      ) : null}
      <StepsBlock message={message} />
      {results}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  message: {
    alignSelf: "stretch",
    gap: theme.v2.space[14],
  },
  text: {
    gap: theme.v2.space[2],
  },
}));
