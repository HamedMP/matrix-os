import { useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { ChatScreenView, type ChatScreenViewProps } from "@/components/chat/ChatScreenView";
import { CHAT_SUGGESTIONS } from "@/components/chat/chat-suggestions";
import { ModelTrigger } from "@/components/chat/ModelTrigger";
import { ResultCard } from "@/components/chat/ResultCard";
import { TabBar } from "@/components/shell/TabBar";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";

import {
  SAMPLE_CHAT_IN_PROGRESS,
  SAMPLE_CHAT_TITLE,
  SAMPLE_FIRST_TURN,
  SAMPLE_FOLLOW_UP,
  SAMPLE_MODEL,
  SAMPLE_RESULT,
} from "./sample-chat";

const noop = () => {};

/** Frame C1: a new chat. Frame C3 draws its sheet over it and opens the sheet from its model trigger. */
export function ChatHomeFrame({ onModelPress }: { onModelPress?: () => void }) {
  return <ChatFrame title="New chat" showHome messages={[]} placeholder="Ask anything" onModelPress={onModelPress} />;
}

/** Frame C1b: a chat with one finished turn and one running. */
export function ChatInProgressFrame() {
  return (
    <ChatFrame
      title={SAMPLE_CHAT_TITLE}
      onNewChat={noop}
      messages={SAMPLE_CHAT_IN_PROGRESS}
      placeholder="Reply…"
      running
    />
  );
}

/** Frame C1c: the follow-up being typed, before it is sent. */
export function ChatTypingFrame() {
  return (
    <ChatFrame
      title={SAMPLE_CHAT_TITLE}
      onNewChat={noop}
      messages={SAMPLE_FIRST_TURN}
      placeholder="Reply…"
      initialDraft={SAMPLE_FOLLOW_UP}
      autoFocus
    />
  );
}

function renderSampleResult(message: TranscriptMessage): ReactNode {
  return message.id === SAMPLE_RESULT.messageId ? <ResultCard app={SAMPLE_RESULT.app} onOpen={noop} /> : null;
}

function ChatFrame({
  title,
  onNewChat,
  showHome = false,
  messages,
  placeholder,
  initialDraft = "",
  autoFocus = false,
  running = false,
  onModelPress = noop,
}: Pick<ChatScreenViewProps, "title" | "onNewChat" | "messages"> & {
  showHome?: boolean;
  placeholder: string;
  initialDraft?: string;
  autoFocus?: boolean;
  running?: boolean;
  onModelPress?: () => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const keyboardVisible = useKeyboardVisible();

  return (
    <View testID="chat-frame" style={styles.frame}>
      <ChatScreenView
        title={title}
        onOpenSidePanel={noop}
        onNewChat={onNewChat}
        showHome={showHome}
        suggestions={CHAT_SUGGESTIONS}
        onSuggestionPress={setDraft}
        messages={messages}
        chatId={showHome ? null : "sample-chat"}
        renderResults={renderSampleResult}
        composer={{
          draft,
          onChangeDraft: setDraft,
          placeholder,
          autoFocus,
          canSend: !running && draft.trim().length > 0,
          onSend: noop,
          running,
          onStop: running ? noop : undefined,
          modelControl: <ModelTrigger {...SAMPLE_MODEL} onPress={onModelPress} />,
        }}
      />
      {/* As in the tabs layout: Android lifts the bar onto the keyboard, so it is hidden there. */}
      {Platform.OS === "android" && keyboardVisible ? null : (
        <TabBar testID="chat-frame-tabs" activeRoute="(chats)" agentsBadgeCount={2} onTabPress={noop} />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    flex: 1,
    backgroundColor: theme.v2.colors.background,
  },
}));
