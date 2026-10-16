"use client";

import { useMemo, useState } from "react";
import type { BrainChatHost, BrainChatSlot, ChatAgentClient } from "@matrix-os/ui";
import { ChatApp } from "@/components/ChatApp";
import { createChatComposerDraftKeeper, type ChatComposerDraftKeeper } from "@/components/chat/useChatComposerDraft";
import type { ChatState } from "@/hooks/useChatState";
import { useCanonicalChatThread } from "@/hooks/useCanonicalChatThread";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { focusOrOpenShellWindow } from "@/lib/shell-window-focus";
import { useChatContext } from "@/stores/chat-context";
import { COMPANY_DRIVE_MOBILE_CHAT_EVENT } from "@/stores/company-drive-chat-draft";

type ChatRuntime = NonNullable<ChatState["chatRuntime"]>;
/** The shell chat authority (`useCanonicalChatAuthority`): a new owner, scope or revoke gives it a new key. */
type ChatAuthority = Pick<ChatState, "agentSummaryClient" | "authorityKey" | "composerIdentity" | "isCurrentAuthority">;

function requestId(): string {
  return `req_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/** Shows the Chat in the Chat app: the Chat window on Web Desktop and Web Canvas, the Chat app on Web Mobile. */
function openInChatApp(switchConversation: (chatId: string) => void, chatId: string, mobile: boolean): void {
  switchConversation(chatId);
  // The mobile shell opens its Chat app on this signal.
  if (mobile) window.dispatchEvent(new Event(COMPANY_DRIVE_MOBILE_CHAT_EVENT));
  else focusOrOpenShellWindow("Chat", "__chat__");
}

function BrainChatThreadView({
  slot, runtime, agents, authority, connected, mobile, active, visible, openInChat, drafts,
}: {
  slot: BrainChatSlot; runtime: ChatRuntime; agents: ChatAgentClient; authority: ChatAuthority; connected: boolean;
  mobile: boolean; active: boolean; visible: boolean; openInChat: (chatId: string) => void;
  drafts: ChatComposerDraftKeeper;
}) {
  const thread = useCanonicalChatThread({
    client: runtime.client, eventSource: runtime.eventSource, chatId: slot.chatId, createChat: slot.createChat,
    onChatChanged: slot.onChatChanged,
    // A refused first question goes back under its new thread for this owner (keyed as ChatApp keys its drafts), so it
    // is there even after the viewer switched threads while it was on its way.
    onDraftReturned: (chatId, draft) => drafts.restore({
      identity: authority.composerIdentity ?? agents, scope: chatId, ...draft,
    }),
  });
  return (
    <ChatApp
      {...thread}
      layout="embedded"
      active={active}
      visible={visible}
      botId={slot.agentId}
      mobile={mobile}
      emptyState={{ title: slot.prompt, detail: slot.promptDetail }}
      // A thread switch remounts this view: the host keeps each thread's unfinished question, and each project's draft.
      composerDrafts={drafts}
      newDraftScope={`new:brain:${slot.projectId}`}
      connected={connected}
      conversations={[]}
      onNewChat={() => undefined}
      onSwitchConversation={openInChat}
      // As in the Chat app: the kept drafts belong to `composerIdentity`, so a new owner never gets them.
      agentClient={agents}
      agentSummaryClient={authority.agentSummaryClient}
      authorityKey={authority.authorityKey}
      composerIdentity={authority.composerIdentity}
      isCurrentAuthority={authority.isCurrentAuthority}
    />
  );
}

/**
 * The Web chat slot of the Company Brain app: the shell's own Chat view (the same transcript, composer, Bot panel and
 * event stream as the Chat app) for one brain chat, with rename and delete over the normal Chat routes. Without the
 * shell chat state (a test, an older host), or while it withholds the agent client after a revoke, it is absent and
 * the Chat tab says chat is not available here.
 */
export function useShellBrainChatHost(mobile: boolean, active: boolean, visible: boolean): BrainChatHost | undefined {
  const chat = useChatContext();
  const runtime = chat?.chatRuntime;
  const switchConversation = chat?.switchConversation;
  const connected = chat?.connected ?? false;
  const agents = chat?.agentClient;
  const agentSummaryClient = chat?.agentSummaryClient;
  const authorityKey = chat?.authorityKey;
  const composerIdentity = chat?.composerIdentity;
  const isCurrentAuthority = chat?.isCurrentAuthority;
  const [drafts] = useState(createChatComposerDraftKeeper);
  return useMemo(() => {
    if (!runtime || !agents || !switchConversation) return undefined;
    const authority: ChatAuthority = { agentSummaryClient, authorityKey, composerIdentity, isCurrentAuthority };
    // Nothing opens, renames or deletes for an authority the chat state has moved on from.
    const current = () => !isCurrentAuthority || isCurrentAuthority();
    const openInChat = (chatId: string) => {
      if (current()) openInChatApp(switchConversation, chatId, mobile);
    };
    // `authorityKey` lets the shared view drop what it loaded for an earlier authority.
    const host: BrainChatHost & { readonly authorityKey?: string } = {
      // Reads go through the guarded summary client, new for each authority; actions pass through it.
      agents: agentSummaryClient ?? agents,
      authorityKey,
      openInChat,
      rows: {
        zIndex: SHELL_Z_INDEX.popover,
        rename: async (record, title) => {
          if (!current()) throw new Error("ChatAuthorityChanged");
          await runtime.client.updateTitle(record.chat.id, { expectedTitleVersion: record.chat.titleVersion ?? 0, title });
        },
        remove: async (chatId) => {
          if (!current()) throw new Error("ChatAuthorityChanged");
          await runtime.client.delete(chatId, requestId());
        },
      },
      // One view per authority: no transcript outlives it, and a new owner's view finds no kept drafts.
      render: (slot: BrainChatSlot) => (
        <BrainChatThreadView key={authorityKey} slot={slot} runtime={runtime} agents={agents} authority={authority}
          connected={connected} mobile={mobile} active={active} visible={visible} openInChat={openInChat}
          drafts={drafts} />
      ),
    };
    return host;
  }, [runtime, agents, agentSummaryClient, authorityKey, composerIdentity, isCurrentAuthority, switchConversation,
    connected, mobile, active, visible, drafts]);
}
