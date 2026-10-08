import type { BrainChatHost, BrainChatSlot } from "@matrix-os/ui";
import { useMemo, useRef } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { canonicalChatRequestId } from "../chat/canonical-chat-submission";
import { CanonicalChatWorkspace } from "../chat/CanonicalChatWorkspace";
import { useWorkSurfaceRuntime } from "../work/WorkSurfaceRuntime";

/** Opens the same Chat in the Chat tab. */
function openInChatTab(chatId: string): void {
  useTabs.getState().openTab({ kind: "chat", title: "Chat", chatId, chatView: "conversation" });
}

/**
 * One brain chat in Electron Desktop's own chat workspace: the same transcript, composer, Bot panel and event stream
 * as the Chat tab. The workspace never opens a Chat tab on its own (`externalNavigation`); a draft becomes a thread
 * through the slot on its first send.
 */
function DesktopBrainChat({ slot, live }: { slot: BrainChatSlot; live: boolean }) {
  const runtime = useWorkSurfaceRuntime();
  const api = useConnection((state) => state.api);
  // The workspace also reports the Chat it opened; the slot picked that one itself, so only turns are passed on,
  // the same as the Web view does.
  const opened = useRef(slot.chatId);
  if (!runtime?.client) return null;
  return (
    <CanonicalChatWorkspace
      api={api ?? undefined}
      client={runtime.client}
      eventSource={runtime.eventSource ?? undefined}
      projectId={null}
      initialChatId={slot.chatId ?? undefined}
      initialView={slot.chatId ? "conversation" : "draft"}
      // Never the active Chat surface: requests meant for the Chat tab (create an app, a Files draft, focus) stay there.
      active={false}
      live={live}
      externalNavigation
      createChat={slot.createChat}
      botId={slot.agentId}
      draftWelcome={{ title: slot.prompt, detail: slot.promptDetail }}
      onActiveChatChanged={(chatId, title) => {
        if (chatId !== null && chatId === opened.current) {
          opened.current = null;
          return;
        }
        slot.onChatChanged(chatId, title);
      }}
    />
  );
}

/** The Electron Desktop chat slot; absent until the tab's chat client exists. */
export function useDesktopBrainChatHost(live: boolean): BrainChatHost | undefined {
  const client = useWorkSurfaceRuntime()?.client;
  return useMemo(() => {
    const agents = client?.agents;
    if (!client || !agents) return undefined;
    return {
      agents,
      openInChat: openInChatTab,
      rows: {
        zIndex: DESKTOP_Z_INDEX.popover,
        rename: async (record, title) => {
          await client.updateTitle(record.chat.id, { expectedTitleVersion: record.chat.titleVersion ?? 0, title });
        },
        remove: async (chatId) => { await client.delete(chatId, canonicalChatRequestId()); },
      },
      render: (slot: BrainChatSlot) => <DesktopBrainChat slot={slot} live={live} />,
    };
  }, [client, live]);
}
