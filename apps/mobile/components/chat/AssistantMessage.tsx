import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";
import { renderChatMarkdown } from "@/lib/chat-markdown";
import { useStreamedTextReveal } from "@/lib/streamed-text-reveal";

import { chatMarkdownTheme } from "./chat-markdown-theme";
import { StepsBlock } from "./StepsBlock";

export interface AssistantMessageProps {
  message: TranscriptMessage;
  /** What belongs under the reply, such as its result cards. */
  results?: ReactNode;
}

/** A reply: its text across the full width, then its steps, then its results. */
export function AssistantMessage({ message, results }: AssistantMessageProps) {
  const { theme } = useUnistyles();
  // While the reply streams, show it at a steady pace with each new chunk
  // fading in, rather than in the uneven bursts the network delivers.
  const reveal = useStreamedTextReveal(message.text, message.isRunning);
  // Re-parses on every text change, which is exactly what a growing streamed
  // string needs -- markdown applies as the text arrives, not once at the end.
  const markdownNodes = useMemo(
    () => renderChatMarkdown(reveal.text, chatMarkdownTheme(theme.v2), reveal.fades),
    [reveal.text, reveal.fades, theme],
  );

  return (
    <View testID="assistant-message" style={styles.message}>
      {message.text ? <View testID="assistant-text" style={styles.text}>{markdownNodes}</View> : null}
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
