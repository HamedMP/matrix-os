import {
  MATRIX_BOT_SELECTION,
  type BotInteraction,
  type CanonicalChatDetailResponse,
  type CanonicalChatModelSelection,
  type CanonicalProviderCatalog,
  type ChatAgent,
} from "@matrix-os/contracts";
import { useCallback, useMemo } from "react";
import { Linking } from "react-native";
import { useAuth } from "@clerk/clerk-expo";

import { activeChatRun, chatLoadState } from "@/components/chat/chat-screen-state";
import { composerAddProps } from "@/components/chat/composer-add";
import { useChatThread } from "@/components/chat/use-chat-thread";
import { defaultTurnModes } from "@/lib/canonical-chat-selection";
import { supportedAttachmentKinds } from "@/lib/chat-attachments";
import { chatDraftKey } from "@/lib/chat-drafts";
import { useBotChat } from "@/lib/queries/use-bot-chat";
import { useCanonicalChatDetail } from "@/lib/queries/use-canonical-chat-detail";
import { useChatProviderCatalog } from "@/lib/queries/use-chat-provider-catalog";
import { useComposerSpeech } from "@/lib/speech/use-composer-speech";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { useChatComposer } from "@/lib/use-chat-composer";
import { useSessionTokenWarmup } from "@/lib/use-session-token-warmup";

import { PendingInteractions } from "./interactions/PendingInteractions";
import { useAgentChatSync } from "./use-agent-chat-sync";

const NO_INTERACTIONS: BotInteraction[] = [];
const TEMPLATE_AGENT_MODES = { interactionMode: "default", permissionMode: "default" };

/** Opens the page where a service is connected. Only a secure link is ever opened. */
export async function openConsentPage(url: string): Promise<void> {
  if (new URL(url).protocol !== "https:") throw new Error("Invalid consent link");
  await Linking.openURL(url);
}

/**
 * The model and modes an agent's turns are sent with. An agent made from a
 * template always runs on the computer's own agent route; any other runs on
 * what its chat was last sent with.
 */
export function agentTurnSetup({ agent, fromTemplate, detail, catalog }: {
  agent: Pick<ChatAgent, "recipeRef" | "selection"> | null;
  /** The chat is known to belong to a template agent, whatever is known of the agent itself. */
  fromTemplate: boolean;
  detail: CanonicalChatDetailResponse | null;
  catalog: CanonicalProviderCatalog | null;
}): { selection: CanonicalChatModelSelection | null; turnModes: { interactionMode: string; permissionMode: string } | null } {
  if (fromTemplate || agent?.recipeRef) return { selection: MATRIX_BOT_SELECTION, turnModes: TEMPLATE_AGENT_MODES };
  const selection = detail?.record.chat.currentSelection ?? agent?.selection ?? null;
  return { selection, turnModes: defaultTurnModes(catalog, selection) };
}

/**
 * An agent's chat, read and sent to by its id. Nothing here reads or changes
 * the Chats tab's active chat. `chatId` is null until the chat is found.
 */
export function useAgentThread({ agent, chatId }: { agent: ChatAgent | null; chatId: string | null }) {
  const { isSignedIn, userId } = useAuth();
  const warmSessionToken = useSessionTokenWarmup();
  const { detail, computer, refresh, isError: chatReadFailed, reload: reloadChat } = useCanonicalChatDetail(chatId);
  const gatewayUrl = computer ? `${HOSTED_GATEWAY_URL}${computer.gatewayPath}` : null;
  // Only an agent made from a template has a status to read.
  const botChat = useBotChat(agent && !agent.recipeRef ? null : chatId, gatewayUrl);
  const { catalog } = useChatProviderCatalog();
  useAgentChatSync(chatId);

  const { selection, turnModes } = agentTurnSetup({ agent, fromTemplate: Boolean(botChat.snapshot), detail, catalog });
  const attachmentKinds = supportedAttachmentKinds(catalog, selection);
  const {
    draft, setDraft, attachments, addAttachments, removeAttachment, attachmentRoom, unreadableAttachments, attachmentNotice,
    sentAttachments, canSend, send, isSending, optimisticMessages, retrySend, editUnsent,
  } = useChatComposer({
    scope: computer ? `${userId ?? ""}:${computer.handle}:${computer.runtimeSlot}` : null,
    activeChatId: chatId,
    detail,
    selection,
    catalog,
    recipeAutomatic: Boolean(botChat.snapshot || agent?.recipeRef),
    turnModes,
    projectId: null,
    attachmentKinds,
    // Without a chat id a send would start a new chat, which is not this
    // agent's; a chat is sent to at the revision it was read at; and the
    // computer refuses a turn while another runs.
    disabled: chatId === null || !detail || activeChatRun(detail) !== undefined,
  });

  const { messages, running, onStop, renderRequest, renderResults, renderComputerPhoto } = useChatThread({
    chatId,
    detail,
    gatewayUrl,
    refresh,
    optimisticMessages,
    sentAttachments,
  });
  const busy = isSending || running;
  const signedIn = Boolean(isSignedIn);
  const unsentActions = useMemo(() => ({ onRetry: retrySend, onEdit: editUnsent }), [retrySend, editUnsent]);

  const handleDraftChange = useCallback((text: string) => {
    setDraft(text);
    warmSessionToken();
  }, [setDraft, warmSessionToken]);

  const speech = useComposerSpeech({
    draftKey: chatDraftKey(chatId),
    draft,
    onChangeDraft: handleDraftChange,
    enabled: signedIn,
  });

  const interactions = botChat.snapshot?.interactions ?? NO_INTERACTIONS;

  return {
    /** The agent's status and the actions on it. Its `snapshot` is null for an agent with no status to read. */
    botChat,
    catalog,
    messages,
    renderRequest,
    renderResults,
    renderComputerPhoto,
    /** The found chat's messages are loading, could not be read, or are there. */
    chatState: chatLoadState({ chatId, loaded: Boolean(detail), failed: chatReadFailed, shownMessages: messages.length }),
    /** Reads the found chat again after it could not be read. */
    reloadChat,
    /** What a message that was not sent offers. */
    unsentActions,
    /** What the agent is waiting on the person for, drawn after the newest message. */
    footer: interactions.length > 0 ? (
      <PendingInteractions
        interactions={interactions}
        actionsAvailable={!botChat.isError}
        onResolve={botChat.resolve}
        onRefresh={botChat.refresh}
        onConnectUrl={openConsentPage}
      />
    ) : null,
    composer: {
      draft,
      onChangeDraft: handleDraftChange,
      editable: signedIn,
      onFocus: warmSessionToken,
      canSend: canSend && signedIn,
      onSend: send,
      running: busy,
      onStop,
      speech,
      ...composerAddProps({
        catalog,
        selection,
        kinds: attachmentKinds,
        attachments,
        room: attachmentRoom,
        unreadable: unreadableAttachments,
        attachmentNotice,
        onAdd: addAttachments,
        onRemove: removeAttachment,
        draft,
        onChangeDraft: handleDraftChange,
        enabled: signedIn,
      }),
    },
  };
}
