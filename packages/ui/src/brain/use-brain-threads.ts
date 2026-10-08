"use client";

import { useEffect, useEffectEvent } from "react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../chat-agents/client.js";
import { botsNotRunning } from "./company-brain-bot.js";
import { useBrainPages } from "./use-brain-load.js";

const THREAD_PAGE_SIZE = 50;

interface BrainThreadPage {
  readonly items: readonly CanonicalChatRecord[];
  readonly nextCursor: string | null;
  /** Bots answered that they are not running here (503). */
  readonly notRunning: boolean;
}

/** Where the viewer's last open brain chat of a project is remembered (per browser; the server list decides). */
export function brainChatStorageKey(projectId: string): string {
  return `matrix-os:brain-chat:${projectId}`;
}

const chatIdOf = (record: CanonicalChatRecord): string => record.chat.id;

/**
 * The Company Brain chats of one project, newest activity first, 50 a page ("Show more" pages on, up to 500). The list
 * loads on open and reloads on `reload` and when the window gets focus, keeping the pages "Show more" added; it opens
 * no event stream of its own.
 */
export function useBrainThreads(agents: ChatAgentClient, botId: string, projectId: string) {
  const pages = useBrainPages<BrainThreadPage>(
    async (cursor) => {
      if (!agents.bots) throw new Error("BotsUnavailable");
      try {
        const page = await agents.bots.threads.list(botId, {
          projectId, limit: THREAD_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }),
        });
        return { items: page.items, nextCursor: page.nextCursor ?? null, notRunning: false };
      } catch (error: unknown) {
        if (cursor === undefined && botsNotRunning(error)) return { items: [], nextCursor: null, notRunning: true };
        throw error;
      }
    },
    `${botId}:${projectId}`,
    0,
    chatIdOf,
  );
  const reload = pages.first.reload;
  const onFocus = useEffectEvent(() => reload());
  useEffect(() => {
    const listener = () => onFocus();
    window.addEventListener("focus", listener);
    return () => window.removeEventListener("focus", listener);
  }, []);
  const notRunning = pages.first.state.status === "ready" && pages.first.state.data.notRunning;
  return { ...pages, reload, notRunning };
}
