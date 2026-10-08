import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";

import { NewChatIcon, SidePanelIcon, TopBar, TopBarButton } from "@/components/ui";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";

import { ChatHome } from "./ChatHome";
import { Composer, type ComposerProps } from "./Composer";
import { MessageList, type MessageListProps } from "./MessageList";

export interface ChatScreenViewProps extends Pick<MessageListProps, "chatId" | "renderRequest" | "renderResults"> {
  /** "New chat", or the open chat's title. */
  title: string;
  onOpenSidePanel: () => void;
  /** Starts a new chat. Offered only while a chat is open. */
  onNewChat?: () => void;
  /** Sits under the top bar, such as an agent's controls. */
  header?: ReactNode;
  /** A problem to tell the person about, in plain words. */
  notice?: string | null;
  /** Nothing has been said yet: the greeting and suggestions take the messages' place. */
  showHome: boolean;
  suggestions: readonly string[];
  onSuggestionPress: (suggestion: string) => void;
  /** Newest first. */
  messages: TranscriptMessage[];
  composer: Omit<ComposerProps, "keyboardOpen">;
}

/** The whole chat screen, drawn from what it is given. It sits above the tab bar. */
export function ChatScreenView({
  title,
  onOpenSidePanel,
  onNewChat,
  header,
  notice,
  showHome,
  suggestions,
  onSuggestionPress,
  messages,
  chatId,
  renderRequest,
  renderResults,
  composer,
}: ChatScreenViewProps) {
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardVisible();

  return (
    // The screen starts at the top of the window and ends at the tab bar, so
    // the keyboard's overlap with it needs no offset: the part of the keyboard
    // that covers the tab bar is already outside this view.
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <TopBar
        title={title}
        leading={
          <TopBarButton
            icon={SidePanelIcon}
            accessibilityLabel="Open chats and projects"
            onPress={onOpenSidePanel}
          />
        }
        trailing={onNewChat ? (
          <TopBarButton icon={NewChatIcon} accessibilityLabel="New chat" onPress={onNewChat} />
        ) : null}
      />
      {header}
      {notice ? <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text> : null}
      {showHome ? (
        <ChatHome suggestions={suggestions} onSuggestionPress={onSuggestionPress} />
      ) : (
        <MessageList
          messages={messages}
          chatId={chatId}
          renderRequest={renderRequest}
          renderResults={renderResults}
        />
      )}
      <Composer {...composer} keyboardOpen={keyboardOpen} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.v2.colors.background,
  },
  notice: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
    textAlign: "center",
    paddingHorizontal: theme.v2.space[20],
  },
}));
