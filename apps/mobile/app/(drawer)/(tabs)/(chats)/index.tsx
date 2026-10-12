import { MATRIX_BOT_SELECTION } from "@matrix-os/contracts";
import "@/lib/hermes-polyfills";
import { useCallback, useEffect, useRef } from "react";
import type { TextInput } from "react-native";
import { useAuth } from "@clerk/clerk-expo";

import { consumeChatDraftRequest, useChatDraftRequest } from "@/components/agents/chat-draft-request";
import { ChatScreenView } from "@/components/chat/ChatScreenView";
import { chatScreenTitle, composerPlaceholder } from "@/components/chat/chat-screen-state";
import { CHAT_SUGGESTIONS } from "@/components/chat/chat-suggestions";
import { ModelTrigger } from "@/components/chat/ModelTrigger";
import { useChatThread } from "@/components/chat/use-chat-thread";
import { ModelPicker } from "@/components/ModelPicker";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { defaultCatalogSelection, defaultTurnModes } from "@/lib/canonical-chat-selection";
import { useBotChat } from "@/lib/queries/use-bot-chat";
import { useCanonicalChatDetail } from "@/lib/queries/use-canonical-chat-detail";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { useChatProviderCatalog } from "@/lib/queries/use-chat-provider-catalog";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { useChatComposer } from "@/lib/use-chat-composer";
import { useSessionTokenWarmup } from "@/lib/use-session-token-warmup";
import { useOpenSidePanel } from "@/lib/use-shell-navigation";

export default function ChatScreen() {
  const { isSignedIn, userId } = useAuth();
  const warmSessionToken = useSessionTokenWarmup();
  const openSidePanel = useOpenSidePanel();
  const {
    activeChatId,
    startDraftChat,
    draftChatRequests,
    selectionOverride,
    setSelectionOverride,
    selectedProjectId,
  } = useCanonicalChatSession();

  const { detail, computer, refresh } = useCanonicalChatDetail(activeChatId);
  const { chats } = useCanonicalChats();
  const gatewayUrl = computer ? `${HOSTED_GATEWAY_URL}${computer.gatewayPath}` : null;
  const botChat = useBotChat(activeChatId, gatewayUrl);
  const { catalog, isPending: catalogPending, isFetching: catalogFetching } = useChatProviderCatalog();

  // An agent's chat is read and answered in the Agents tab. One opened here
  // all the same keeps its fixed model, so a message can still be sent.
  const directBot = Boolean(botChat.snapshot);
  // The picker marks the catalog as being checked whenever it is fetched.
  // Sending only waits when there is no catalog to choose a model from yet:
  // one that is merely being re-checked already gives the selection, and the
  // computer validates that selection when it admits the turn.
  const providerCatalogChecking = !directBot && (catalogPending || catalogFetching);
  const providerCatalogLoading = !directBot && catalogPending;
  const selection = directBot ? MATRIX_BOT_SELECTION : selectionOverride
    ?? detail?.record.chat.currentSelection
    ?? defaultCatalogSelection(catalog);
  const turnModes = directBot ? { interactionMode: "default", permissionMode: "default" } : defaultTurnModes(catalog, selection);

  const { draft, setDraft, send, isSending, optimisticMessages } = useChatComposer({
    scope: computer ? `${userId ?? ""}:${computer.handle}:${computer.runtimeSlot}` : null,
    activeChatId,
    detail,
    selection,
    turnModes,
    projectId: selectedProjectId,
    // The selection is not final until the provider catalog has loaded.
    disabled: providerCatalogLoading,
  });

  const { messages, running, onStop, renderRequest, renderResults } = useChatThread({
    chatId: activeChatId,
    detail,
    gatewayUrl,
    refresh,
    optimisticMessages,
  });
  const busy = isSending || running;
  const isConnected = Boolean(isSignedIn);
  const canSend = !providerCatalogLoading && draft.trim().length > 0 && isConnected
    && Boolean(selection) && Boolean(turnModes) && !busy;

  const inputRef = useRef<TextInput>(null);
  // The composer takes the cursor, and with it the keyboard, only when the
  // person asks for a new chat. Opening the screen or a chat leaves the
  // keyboard closed, so the tabs stay in view.
  const answeredDraftRequest = useRef(draftChatRequests);
  useEffect(() => {
    if (answeredDraftRequest.current === draftChatRequests) return;
    answeredDraftRequest.current = draftChatRequests;
    // A turn later: the side panel puts the keyboard away as it starts to
    // close, which would otherwise undo this.
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [draftChatRequests]);

  // Another screen can ask for text in the new chat's composer, as "Set up in
  // chat instead" does. It is taken once, and only by the new chat: while a
  // chat is still open it waits for the new chat that was asked for with it.
  const draftRequest = useChatDraftRequest();
  useEffect(() => {
    if (!draftRequest || activeChatId !== null) return;
    setDraft(draftRequest.text);
    consumeChatDraftRequest(draftRequest.id);
  }, [draftRequest, activeChatId, setDraft]);

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

  const handleNewChat = useCallback(() => startDraftChat(), [startDraftChat]);

  return (
    <ChatScreenView
      title={chatScreenTitle(activeChatId, detail, chats)}
      onOpenSidePanel={openSidePanel}
      onNewChat={activeChatId ? handleNewChat : undefined}
      showHome={activeChatId === null && messages.length === 0}
      suggestions={CHAT_SUGGESTIONS}
      onSuggestionPress={handleSuggestionPress}
      messages={messages}
      chatId={activeChatId}
      renderRequest={renderRequest}
      renderResults={renderResults}
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
