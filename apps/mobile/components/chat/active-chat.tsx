import {
  canonicalChatExecutionControls,
  MATRIX_BOT_SELECTION,
  type CanonicalChatDetailResponse,
  type CanonicalChatExecutionControls,
  type CanonicalChatModelSelection,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { createContext, use, useCallback, useEffect, type ReactNode } from "react";
import { useAuth } from "@clerk/clerk-expo";

import { consumeChatDraftRequest, useChatDraftRequest } from "@/components/agents/chat-draft-request";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { chosenTurnModes, defaultCatalogSelection } from "@/lib/canonical-chat-selection";
import { supportedAttachmentKinds } from "@/lib/chat-attachments";
import { useBotChat } from "@/lib/queries/use-bot-chat";
import { useCanonicalChatDetail } from "@/lib/queries/use-canonical-chat-detail";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { useChatProviderCatalog } from "@/lib/queries/use-chat-provider-catalog";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import {
  composerChoiceScope,
  useRememberedComposerChoice,
  type RememberedComposerChoice,
} from "@/lib/remembered-composer-choice";
import { useChatComposer } from "@/lib/use-chat-composer";

import { activeChatRun } from "./chat-screen-state";
import { providerComposerPreference } from "@/lib/provider-composer-preference";
import { newChatSelection } from "./new-chat-selection";

function savedChatExecutionControls(detail: CanonicalChatDetailResponse | null, chatId: string | null) {
  if (!detail || detail.record.chat.id !== chatId) return undefined;
  return canonicalChatExecutionControls({
    chatId: detail.record.chat.id, currentSelection: detail.record.chat.currentSelection, runs: detail.runs,
  });
}

// A chat with an agent runs in the agent's own modes.
const AGENT_TURN_MODES = { interactionMode: "default", permissionMode: "default" };

/**
 * The permission mode asked for the chat on screen: the one chosen for it on
 * this phone, else the one an open chat last ran with, else, for a new chat,
 * the one last chosen on this phone. Null when there is none: the engine's
 * default then applies.
 */
function askedPermissionMode(
  activeChatId: string | null,
  chosen: string | null | undefined,
  saved: CanonicalChatExecutionControls | undefined,
  remembered: RememberedComposerChoice | null,
): string | null {
  if (chosen) return chosen;
  if (activeChatId !== null) return saved?.permissionMode ?? null;
  return remembered?.permissionMode ?? null;
}

interface ChatScreenSelectionSources {
  directBot: boolean;
  activeChatId: string | null;
  selectionOverride: CanonicalChatModelSelection | null;
  /** The model the open chat was last sent with. */
  saved: CanonicalChatModelSelection | undefined;
  catalog: CanonicalProviderCatalog | null;
  remembered: { ready: boolean; choice: RememberedComposerChoice | null };
}

/**
 * The model of the chat on screen, and whether it waits for the choice saved
 * on this phone: a new chat starts on the model last chosen here, so its model
 * is not known, and nothing is sent, until the phone's storage has been read.
 */
function chatScreenSelection({
  directBot, activeChatId, selectionOverride, saved, catalog, remembered,
}: ChatScreenSelectionSources): { selection: CanonicalChatModelSelection | null; rememberedPending: boolean } {
  if (directBot) return { selection: MATRIX_BOT_SELECTION, rememberedPending: false };
  const chosen = selectionOverride ?? saved;
  if (chosen) return { selection: chosen, rememberedPending: false };
  if (activeChatId !== null) return { selection: defaultCatalogSelection(catalog), rememberedPending: false };
  if (!remembered.ready) return { selection: null, rememberedPending: true };
  return { selection: newChatSelection(catalog, { remembered: remembered.choice?.selection }), rememberedPending: false };
}

function useActiveChatState() {
  const { isSignedIn, userId } = useAuth();
  const {
    activeChatId, selectionOverride, setSelectionOverride, permissionModeOverride, setPermissionModeOverride, selectedProjectId,
  } = useCanonicalChatSession();

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
  const remembered = useRememberedComposerChoice(composerChoiceScope(userId, computer));

  // An agent's chat is read and answered in the Agents tab. One opened here
  // all the same keeps its fixed model, so a message can still be sent.
  const directBot = Boolean(botChat.snapshot);
  // The picker marks the catalog as being checked whenever it is fetched.
  // Sending only waits when there is no catalog to choose a model from yet:
  // one that is merely being re-checked already gives the selection, and the
  // computer validates that selection when it admits the turn.
  const { selection, rememberedPending } = chatScreenSelection({
    directBot, activeChatId, selectionOverride, saved: detail?.record.chat.currentSelection, catalog, remembered,
  });
  const providerCatalogChecking = !directBot && (catalogPending || catalogFetching || rememberedPending);
  const providerCatalogLoading = !directBot && (catalogPending || rememberedPending);
  const { remember, forProvider } = remembered;
  const savedControls = savedChatExecutionControls(detail, activeChatId);
  const turnModes = directBot ? AGENT_TURN_MODES : chosenTurnModes(catalog, selection, savedControls,
    askedPermissionMode(activeChatId, permissionModeOverride, savedControls, forProvider(selection?.instanceId)));
  const chooseSelection = useCallback((chosen: CanonicalChatModelSelection) => {
    const switching = selection?.instanceId !== chosen.instanceId;
    const preference = providerComposerPreference(catalog, selection, chosen, forProvider(chosen.instanceId), turnModes?.permissionMode);
    setSelectionOverride(preference.selection);
    if (switching) setPermissionModeOverride(preference.permissionMode ?? null);
    remember(preference);
  }, [selection, forProvider, catalog, turnModes, setSelectionOverride, setPermissionModeOverride, remember]);
  const choosePermissionMode = useCallback((mode: string) => {
    if (!selection) return;
    setPermissionModeOverride(mode);
    remember({ selection, permissionMode: mode });
  }, [selection, setPermissionModeOverride, remember]);

  const attachmentKinds = supportedAttachmentKinds(catalog, selection);

  const composer = useChatComposer({
    scope: computer ? `${userId ?? ""}:${computer.handle}:${computer.runtimeSlot}` : null,
    activeChatId,
    detail,
    selection,
    catalog,
    recipeAutomatic: directBot,
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
    routineOriginEligible: !chatReadFailed && botChat.resolved && !directBot && detail && detail.record.chat.id === activeChatId && detail.record.chat.ownerScope.type === "personal" && detail.record.chat.lifecycle === "active" && !detail.record.chat.collaboration,
    providerCatalogChecking,
    selection,
    /** Chooses the model of the chat on screen, and remembers it on this phone for the next new chat. */
    chooseSelection,
    /** The permission mode the next message is sent with, once there is a model to send it to. */
    permissionMode: turnModes?.permissionMode ?? null,
    /** Chooses it for the chat on screen, from its next message, and remembers it on this phone for the next new chat. */
    choosePermissionMode,
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
