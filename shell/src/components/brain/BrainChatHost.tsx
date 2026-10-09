"use client";

import { useMemo, useState } from "react";
import type { BrainChatHost, BrainChatSlot } from "@matrix-os/ui";
import { ChatApp } from "@/components/ChatApp";
import { createChatComposerDraftKeeper, type ChatComposerDraftKeeper } from "@/components/chat/useChatComposerDraft";
import type { ChatState } from "@/hooks/useChatState";
import { useCanonicalChatThread } from "@/hooks/useCanonicalChatThread";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { focusOrOpenShellWindow } from "@/lib/shell-window-focus";
import { useChatContext } from "@/stores/chat-context";
import { COMPANY_DRIVE_MOBILE_CHAT_EVENT } from "@/stores/company-drive-chat-draft";

type ChatRuntime = NonNullable<ChatState["chatRuntime"]>;

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

function BrainChatThreadView({ slot, runtime, connected, mobile, active, visible, openInChat, drafts }: {
  slot: BrainChatSlot; runtime: ChatRuntime; connected: boolean; mobile: boolean; active: boolean; visible: boolean;
  openInChat: (chatId: string) => void; drafts: ChatComposerDraftKeeper;
}) {
  const thread = useCanonicalChatThread({
    client: runtime.client, eventSource: runtime.eventSource, chatId: slot.chatId, createChat: slot.createChat,
    onChatChanged: slot.onChatChanged,
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
      agentClient={runtime.client.agents}
    />
  );
}

/**
 * The Web chat slot of the Company Brain app: the shell's own Chat view (the same transcript, composer, Bot panel and
 * event stream as the Chat app) for one brain chat, with rename and delete over the normal Chat routes. Without the
 * shell chat state (a test, an older host) it is absent and the Chat tab says chat is not available here.
 */
export function useShellBrainChatHost(mobile: boolean, active: boolean, visible: boolean): BrainChatHost | undefined {
  const chat = useChatContext();
  const runtime = chat?.chatRuntime;
  const switchConversation = chat?.switchConversation;
  const connected = chat?.connected ?? false;
  const [drafts] = useState(createChatComposerDraftKeeper);
  return useMemo(() => {
    const agents = runtime?.client.agents;
    if (!runtime || !agents || !switchConversation) return undefined;
    const openInChat = (chatId: string) => openInChatApp(switchConversation, chatId, mobile);
    return {
      agents,
      openInChat,
      rows: {
        zIndex: SHELL_Z_INDEX.popover,
        rename: async (record, title) => {
          await runtime.client.updateTitle(record.chat.id, { expectedTitleVersion: record.chat.titleVersion ?? 0, title });
        },
        remove: (chatId) => runtime.client.delete(chatId, requestId()),
      },
      render: (slot: BrainChatSlot) => (
        <BrainChatThreadView slot={slot} runtime={runtime} connected={connected} mobile={mobile} active={active}
          visible={visible} openInChat={openInChat} drafts={drafts} />
      ),
    };
  }, [runtime, switchConversation, connected, mobile, active, visible, drafts]);
}
