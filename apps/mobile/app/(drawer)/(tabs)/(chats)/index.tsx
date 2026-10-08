import { MATRIX_BOT_SELECTION } from "@matrix-os/contracts";
import "@/lib/hermes-polyfills";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Linking, type TextInput } from "react-native";
import { useAuth } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";

import { consumeChatDraftRequest, useChatDraftRequest } from "@/components/agents/chat-draft-request";
import { BotChatControls } from "@/components/BotChatControls";
import { CanonicalApprovalMessage } from "@/components/CanonicalApprovalMessage";
import { CanonicalInputMessage } from "@/components/CanonicalInputMessage";
import { ChatScreenView } from "@/components/chat/ChatScreenView";
import {
  activeChatRun,
  allowsHomeRelativeAppPaths,
  chatScreenTitle,
  composerPlaceholder,
} from "@/components/chat/chat-screen-state";
import { CHAT_SUGGESTIONS } from "@/components/chat/chat-suggestions";
import { ModelTrigger } from "@/components/chat/ModelTrigger";
import { ReplyResultApps } from "@/components/chat/ReplyResultApps";
import type { ChatResultApp } from "@/components/chat/types";
import { ModelPicker } from "@/components/ModelPicker";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { defaultCatalogSelection, defaultTurnModes } from "@/lib/canonical-chat-selection";
import {
  buildTranscript,
  optimisticTranscriptMessage,
  type TranscriptMessage,
} from "@/lib/canonical-chat-transcript";
import { useBotChat } from "@/lib/queries/use-bot-chat";
import { useCancelRun } from "@/lib/queries/use-cancel-run";
import { useCanonicalChatDetail } from "@/lib/queries/use-canonical-chat-detail";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { useChatProviderCatalog } from "@/lib/queries/use-chat-provider-catalog";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { useChatComposer } from "@/lib/use-chat-composer";
import { useSessionTokenWarmup } from "@/lib/use-session-token-warmup";
import { useOpenSidePanel } from "@/lib/use-shell-navigation";

export default function ChatScreen() {
  const { isSignedIn, userId } = useAuth();
  const router = useRouter();
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
  const cancelRun = useCancelRun();

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

  const messages = useMemo(() => {
    const transcript = buildTranscript(detail);
    if (optimisticMessages.length === 0) return transcript;
    // Newest-first, matching the inverted transcript FlatList.
    return [...optimisticMessages.map(optimisticTranscriptMessage).reverse(), ...transcript];
  }, [detail, optimisticMessages]);

  const activeRun = activeChatRun(detail);
  const activeRunId = activeRun?.id;
  const busy = isSending || Boolean(activeRun);
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

  const { mutate: requestCancel, isPending: cancelPending } = cancelRun;
  // A failed request changes nothing here: the run is still listed as active,
  // so the button is simply there to be pressed again.
  const handleStop = useMemo(() => (
    activeChatId && activeRunId && !cancelPending
      ? () => requestCancel({ chatId: activeChatId, runId: activeRunId })
      : undefined
  ), [activeChatId, activeRunId, cancelPending, requestCancel]);

  const renderRequest = useCallback((item: TranscriptMessage) => {
    if (!activeChatId || !gatewayUrl) return null;
    if (item.input) {
      return (
        <CanonicalInputMessage
          key={`${activeChatId}:${item.input.runId}:${item.input.requestId}`}
          request={item.input}
          chatId={activeChatId}
          gatewayUrl={gatewayUrl}
          onSettled={refresh}
        />
      );
    }
    if (item.approval) {
      return (
        <CanonicalApprovalMessage
          key={`${activeChatId}:${item.approval.runId}:${item.approval.approvalId}`}
          approval={item.approval}
          chatId={activeChatId}
          gatewayUrl={gatewayUrl}
          onSettled={refresh}
        />
      );
    }
    return null;
  }, [activeChatId, gatewayUrl, refresh]);

  const openApp = useCallback((app: ChatResultApp) => {
    router.push({ pathname: "/app-preview/[app]", params: { app: app.slug, name: app.name } } as never);
  }, [router]);

  const renderResults = useCallback((item: TranscriptMessage) => (
    <ReplyResultApps
      text={item.text}
      allowRelative={allowsHomeRelativeAppPaths(detail, item.id)}
      onOpen={openApp}
    />
  ), [detail, openApp]);

  return (
    <ChatScreenView
      title={chatScreenTitle(activeChatId, detail, chats)}
      onOpenSidePanel={openSidePanel}
      onNewChat={activeChatId ? handleNewChat : undefined}
      header={botChat.snapshot ? (
        <BotChatControls
          catalog={catalog}
          snapshot={botChat.snapshot}
          actionsAvailable={!botChat.isError}
          onSelectionChange={botChat.updateModel}
          onResolve={botChat.resolve}
          onRevoke={botChat.revoke}
          onMemory={botChat.memory}
          onRefresh={botChat.refresh}
          onConnectUrl={async (url) => {
            if (new URL(url).protocol !== "https:") throw new Error("Invalid consent link");
            await Linking.openURL(url);
          }}
        />
      ) : null}
      notice={botChat.isError && activeChatId ? "Bot status could not be loaded. Try again." : null}
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
        onStop: handleStop,
        modelControl: directBot ? <ModelTrigger label="Bot model" fixed /> : (
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
