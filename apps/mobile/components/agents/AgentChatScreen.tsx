import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";

import { Composer, type ComposerProps } from "@/components/chat/Composer";
import { MessageList, type MessageListProps } from "@/components/chat/MessageList";
import { ListRowSkeletonStack } from "@/components/shell/Controls";
import { AgentMascot, BackIcon, Button, InfoIcon, TopBar, TopBarButton } from "@/components/ui";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";

const BACK_ICON_SIZE = 22;
const INFO_ICON_SIZE = 18;
const MASCOT_SIZE = 32;

export interface AgentChatScreenProps
  extends Pick<MessageListProps, "chatId" | "renderRequest" | "renderResults" | "footer"> {
  agent: {
    id: string;
    name: string;
    /** Decides the mascot's colour. Saved agents have none: the server sends no category. */
    category?: string;
  };
  /** "loading": the agent's chat is being found. "failed": it could not be. */
  state: "loading" | "failed" | "ready";
  onBack: () => void;
  onOpenDetails: () => void;
  /** Looks for the agent's chat again after "failed". */
  onRetry: () => void;
  /** A problem to tell the person about, in plain words. */
  notice?: string | null;
  /** Newest first. */
  messages: TranscriptMessage[];
  composer: Omit<ComposerProps, "keyboardOpen" | "placeholder" | "modelControl">;
}

/** An agent's own chat. It takes the whole display: the tab bar is hidden under it. */
export function AgentChatScreen({
  agent,
  state,
  onBack,
  onOpenDetails,
  onRetry,
  notice,
  messages,
  chatId,
  renderRequest,
  renderResults,
  footer,
  composer,
}: AgentChatScreenProps) {
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardVisible();
  // Android shrinks the window for the keyboard, which then covers this space.
  const homeIndicatorSpace = Platform.OS === "android" && keyboardOpen ? 0 : insets.bottom;

  return (
    // With no tab bar below, the screen ends at the bottom of the window, so
    // the home indicator's space is its own: a view at the end, because this
    // one replaces its own bottom padding. The keyboard covers that space, and
    // only the rest of its height is made room for.
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={-insets.bottom}
    >
      <TopBar
        testID="agent-chat-top-bar"
        align="start"
        title={agent.name}
        leading={(
          <TopBarButton icon={BackIcon} iconSize={BACK_ICON_SIZE} accessibilityLabel="Back" onPress={onBack} />
        )}
        titleLeading={<AgentMascot id={agent.id} name={agent.name} category={agent.category} size={MASCOT_SIZE} />}
        trailing={(
          <TopBarButton
            filled
            icon={InfoIcon}
            iconSize={INFO_ICON_SIZE}
            accessibilityLabel="Agent details"
            onPress={onOpenDetails}
          />
        )}
      />
      {notice ? <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text> : null}
      {state === "loading" ? (
        <View testID="agent-chat-loading" style={styles.body}>
          <ListRowSkeletonStack testID="agent-chat-skeleton-row" />
        </View>
      ) : state === "failed" ? (
        <View testID="agent-chat-failed" style={[styles.body, styles.failed]}>
          <Text accessibilityRole="alert" style={styles.failedText}>This agent&apos;s chat could not be opened.</Text>
          <Button variant="outline" label="Try again" onPress={onRetry} />
        </View>
      ) : (
        <>
          <MessageList
            messages={messages}
            chatId={chatId}
            renderRequest={renderRequest}
            renderResults={renderResults}
            footer={footer}
          />
          <Composer {...composer} placeholder={`Ask ${agent.name}…`} keyboardOpen={keyboardOpen} />
        </>
      )}
      <View testID="agent-chat-bottom-inset" style={{ height: homeIndicatorSpace }} />
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
  body: {
    flex: 1,
    paddingHorizontal: theme.v2.space[20],
  },
  failed: {
    alignItems: "center",
    gap: theme.v2.space[16],
    paddingTop: theme.v2.space[24],
  },
  failedText: {
    ...theme.v2.text.label,
    color: theme.v2.colors.textSubtle,
    textAlign: "center",
  },
}));
