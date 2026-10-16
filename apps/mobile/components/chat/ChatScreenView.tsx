import { KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";

import { NewChatIcon, SidePanelIcon, TopBar, TopBarButton } from "@/components/ui";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";

import { ChatHome } from "./ChatHome";
import { ChatMessagesSkeleton, ChatUnavailable } from "./ChatLoadState";
import type { ChatLoadState } from "./chat-screen-state";
import { Composer, type ComposerProps } from "./Composer";
import { MessageList, type MessageListProps } from "./MessageList";
import { UnsentMessageActionsProvider, type UnsentMessageActions } from "./unsent-message-actions";

export interface ChatScreenViewProps
  extends Pick<MessageListProps, "chatId" | "renderRequest" | "renderResults" | "renderComputerPhoto"> {
  /** "New chat", or the open chat's title. */
  title: string;
  onOpenSidePanel: () => void;
  /** Starts a new chat. Offered only while a chat is open. */
  onNewChat?: () => void;
  /** Nothing has been said yet: the greeting and suggestions take the messages' place. */
  showHome: boolean;
  suggestions: readonly string[];
  onSuggestionPress: (suggestion: string) => void;
  /** Newest first. */
  messages: TranscriptMessage[];
  /** For an open chat: its messages are loading, could not be read, or are there. Ready when left out. */
  chatState?: ChatLoadState;
  /** Reads the chat again after it could not be read; the loading state shows meanwhile. */
  onReloadChat?: () => void;
  /** What a message that was not sent offers. Nothing is offered when left out. */
  unsentActions?: UnsentMessageActions | null;
  composer: Omit<ComposerProps, "keyboardOpen">;
}

/** The whole chat screen, drawn from what it is given. It sits above the tab bar. */
export function ChatScreenView({
  title,
  onOpenSidePanel,
  onNewChat,
  showHome,
  suggestions,
  onSuggestionPress,
  messages,
  chatId,
  renderRequest,
  renderResults,
  renderComputerPhoto,
  chatState = "ready",
  onReloadChat,
  unsentActions = null,
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
      {showHome ? (
        <ChatHome suggestions={suggestions} onSuggestionPress={onSuggestionPress} />
      ) : chatState === "loading" ? (
        <ChatMessagesSkeleton />
      ) : chatState === "failed" ? (
        <ChatUnavailable onRetry={onReloadChat} />
      ) : (
        <UnsentMessageActionsProvider value={unsentActions}>
          <MessageList
            messages={messages}
            chatId={chatId}
            renderRequest={renderRequest}
            renderResults={renderResults}
            renderComputerPhoto={renderComputerPhoto}
          />
        </UnsentMessageActionsProvider>
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
}));
