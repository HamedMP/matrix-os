import { MATRIX_BOT_SELECTION } from "@matrix-os/contracts";
import { createContext, use, useEffect, type ReactNode } from "react";
import { useAuth } from "@clerk/clerk-expo";

import { consumeChatDraftRequest, useChatDraftRequest } from "@/components/agents/chat-draft-request";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { defaultCatalogSelection, defaultTurnModes } from "@/lib/canonical-chat-selection";
import { supportedAttachmentKinds } from "@/lib/chat-attachments";
import { useBotChat } from "@/lib/queries/use-bot-chat";
import { useCanonicalChatDetail } from "@/lib/queries/use-canonical-chat-detail";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { useChatProviderCatalog } from "@/lib/queries/use-chat-provider-catalog";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { useChatComposer } from "@/lib/use-chat-composer";

import { activeChatRun } from "./chat-screen-state";

function useActiveChatState() {
  const { isSignedIn, userId } = useAuth();
  const { activeChatId, selectionOverride, setSelectionOverride, selectedProjectId } = useCanonicalChatSession();

  const {
    detail, computer, refresh, isError: chatReadFailed, reload: reloadChat,
  } = useCanonicalChatDetail(activeChatId);
  // An open chat is sent to at the revision it was read at, so nothing is
  // sent to it before it has been read -- nor while a run is active, which
  // the computer would refuse. Holding sends back holds Retry of a message
  // that was not sent as well as the Send button.
  const chatUnread = activeChatId !== null && !detail;
  const runActive = activeChatRun(detail) !== undefined;
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

  const attachmentKinds = supportedAttachmentKinds(catalog, selection);

  const composer = useChatComposer({
    scope: computer ? `${userId ?? ""}:${computer.handle}:${computer.runtimeSlot}` : null,
    activeChatId,
    detail,
    selection,
    turnModes,
    projectId: selectedProjectId,
    attachmentKinds,
    // The selection is not final until the provider catalog has loaded.
    disabled: providerCatalogLoading || chatUnread || runActive,
  });

  // Another screen can ask for text in the new chat's composer, as "Set up in
  // chat instead" does. It is taken once, and only by the new chat: while a
  // chat is still open it waits for the new chat that was asked for with it.
  const draftRequest = useChatDraftRequest();
  const { setDraft } = composer;
  useEffect(() => {
    if (!draftRequest || activeChatId !== null) return;
    setDraft(draftRequest.text);
    consumeChatDraftRequest(draftRequest.id);
  }, [draftRequest, activeChatId, setDraft]);

  return {
    connected: Boolean(isSignedIn),
    activeChatId,
    detail,
    refresh,
    chatReadFailed,
    reloadChat,
    chatUnread,
    chats,
    gatewayUrl,
    catalog,
    directBot,
    providerCatalogChecking,
    selection,
    setSelectionOverride,
    attachmentKinds,
    composer,
  };
}

export type ActiveChat = ReturnType<typeof useActiveChatState>;

const ActiveChatContext = createContext<ActiveChat | null>(null);

/**
 * The chat open in the session, read once for every screen that shows it, with
 * its composer's drafts and the messages that were not sent. It sits above the
 * Chats stack, so a chat opened from a project keeps them when it goes back.
 */
export function ActiveChatProvider({ children }: { children: ReactNode }) {
  const activeChat = useActiveChatState();
  return <ActiveChatContext value={activeChat}>{children}</ActiveChatContext>;
}

export function useActiveChat(): ActiveChat {
  const activeChat = use(ActiveChatContext);
  if (!activeChat) throw new Error("useActiveChat needs an ActiveChatProvider above it");
  return activeChat;
}
