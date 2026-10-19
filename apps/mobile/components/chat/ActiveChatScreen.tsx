import "@/lib/hermes-polyfills";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TextInput } from "react-native";

import { ModelPicker } from "@/components/ModelPicker";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { useSessionTokenWarmup } from "@/lib/use-session-token-warmup";
import { useOpenSidePanel } from "@/lib/use-shell-navigation";

import { useActiveChat } from "./active-chat";
import { ChatScreenView } from "./ChatScreenView";
import { chatLoadState, chatScreenTitle, composerPlaceholder } from "./chat-screen-state";
import { CHAT_SUGGESTIONS } from "./chat-suggestions";
import { composerAddProps } from "./composer-add";
import { ModelTrigger } from "./ModelTrigger";
import { useChatThread } from "./use-chat-thread";

export interface ActiveChatScreenProps {
  /**
   * Given, the top bar goes back with it in place of opening the side panel,
   * as on a chat opened from a project.
   */
  onBack?: () => void;
  /** Given, a new chat starts with it in place of a new chat on this screen. */
  onNewChat?: () => void;
}

/**
 * The chat open in the session, or a new one: the Chats tab's first screen, and
 * a chat opened from a project, above the project.
 */
export function ActiveChatScreen({ onBack, onNewChat }: ActiveChatScreenProps) {
  const warmSessionToken = useSessionTokenWarmup();
  const openSidePanel = useOpenSidePanel();
  const { startDraftChat, draftChatRequests } = useCanonicalChatSession();
  const {
    connected: isConnected, activeChatId, detail, refresh, chatReadFailed, reloadChat, chatUnread, chats, gatewayUrl,
    catalog, directBot, providerCatalogChecking, selection, setSelectionOverride, attachmentKinds, composer,
  } = useActiveChat();
  const {
    draft, setDraft, attachments, addAttachments, removeAttachment, attachmentRoom, unreadableAttachments,
    sentAttachments, canSend: composerCanSend, send, isSending, optimisticMessages, retrySend, editUnsent,
  } = composer;
  const unsentActions = useMemo(() => ({ onRetry: retrySend, onEdit: editUnsent }), [retrySend, editUnsent]);

  const { messages, running, onStop, renderRequest, renderResults, renderComputerPhoto } = useChatThread({
    chatId: activeChatId,
    detail,
    gatewayUrl,
    refresh,
    optimisticMessages,
    sentAttachments,
  });
  const busy = isSending || running;
  const canSend = composerCanSend && isConnected;
  const chatState = chatLoadState({
    chatId: activeChatId,
    loaded: !chatUnread,
    failed: chatReadFailed,
    shownMessages: messages.length,
  });

  const inputRef = useRef<TextInput>(null);
  // The composer takes the cursor, and with it the keyboard, only when the
  // person asks for a new chat. Opening the screen or a chat leaves the
  // keyboard closed, so the tabs stay in view. A screen that starts its new
  // chats elsewhere leaves the request to the screen that starts them.
  const answeredDraftRequest = useRef(draftChatRequests);
  const startsNewChats = !onNewChat;
  useEffect(() => {
    if (answeredDraftRequest.current === draftChatRequests) return;
    answeredDraftRequest.current = draftChatRequests;
    if (!startsNewChats) return;
    // A turn later: the side panel puts the keyboard away as it starts to
    // close, which would otherwise undo this.
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [draftChatRequests, startsNewChats]);

  const handleDraftChange = useCallback((text: string) => {
    setDraft(text);
    warmSessionToken();
  }, [setDraft, warmSessionToken]);

  // Web and desktop put a starter in the composer rather than sending it.
  const handleSuggestionPress = useCallback((suggestion: string) => {
    setDraft(suggestion);
    warmSessionToken();
    inputRef.current?.focus();
  }, [setDraft, warmSessionToken]);

  const handleNewChat = useCallback(() => {
    if (onNewChat) onNewChat();
    else startDraftChat();
  }, [onNewChat, startDraftChat]);

  return (
    <ChatScreenView
      title={chatScreenTitle(activeChatId, detail, chats)}
      onOpenSidePanel={openSidePanel}
      onBack={onBack}
      onNewChat={activeChatId ? handleNewChat : undefined}
      showHome={activeChatId === null && messages.length === 0}
      suggestions={CHAT_SUGGESTIONS}
      onSuggestionPress={handleSuggestionPress}
      messages={messages}
      chatId={activeChatId}
      renderRequest={renderRequest}
      renderResults={renderResults}
      renderComputerPhoto={renderComputerPhoto}
      chatState={chatState}
      onReloadChat={reloadChat}
      unsentActions={unsentActions}
      composer={{
        inputRef,
        draft,
        onChangeDraft: handleDraftChange,
        placeholder: composerPlaceholder({ connected: isConnected, chatOpen: activeChatId !== null }),
        editable: isConnected,
        onFocus: warmSessionToken,
        canSend,
        onSend: send,
        running: busy,
        onStop,
        ...composerAddProps({
          catalog,
          selection,
          kinds: attachmentKinds,
          attachments,
          room: attachmentRoom,
          unreadable: unreadableAttachments,
          onAdd: addAttachments,
          onRemove: removeAttachment,
          draft,
          onChangeDraft: handleDraftChange,
          enabled: isConnected,
        }),
        modelControl: directBot ? <ModelTrigger label="Agent model" fixed /> : (
          <ModelPicker
            catalog={catalog}
            catalogLoading={providerCatalogChecking}
            selection={selection}
            onSelectionChange={setSelectionOverride}
          />
        ),
      }}
    />
  );
}
