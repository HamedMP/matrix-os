import type { BrainChatHost, BrainChatSlot } from "@matrix-os/ui";
import { useMemo, useState } from "react";
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
  // The Chat shown follows this workspace's own reports, not the slot: the slot shows a draft's thread once it exists,
  // and moving there before the first turn is admitted would empty the composer and lose a refused question.
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- seeded from the slot once on purpose, then moved only by this workspace's reports; another slot Chat remounts this view.
  const [chatId, setChatId] = useState(slot.chatId);
  if (!runtime?.client) return null;
  return (
    <CanonicalChatWorkspace
      api={api ?? undefined}
      client={runtime.client}
      eventSource={runtime.eventSource ?? undefined}
      projectId={null}
      initialChatId={chatId ?? undefined}
      initialView={chatId ? "conversation" : "draft"}
      // Never the active Chat surface: requests meant for the Chat tab (create an app, a Files draft, focus) stay there.
      active={false}
      live={live}
      externalNavigation
      createChat={slot.createChat}
      botId={slot.agentId}
      draftWelcome={{ title: slot.prompt, detail: slot.promptDetail }}
      // Each project's brain draft is its own, never the Chat tab's new-chat draft.
      newDraftScope={`new:brain:${slot.projectId}`}
      onActiveChatChanged={(shown, title) => {
        setChatId(shown);
        slot.onChatChanged(shown, title);
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
