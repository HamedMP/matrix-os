import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatAgent } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../client.js";
import { botSummaryReads } from "./bot-summary-reads.js";
import { BOT_RAIL_IDLE, BOT_RAIL_LOADING, BOT_RAIL_UNAVAILABLE, botRailStatus, type BotRailStatus } from "./bot-rail-status.js";

const MAX_AGENTS = 100;
const REFRESH_MS = 15_000;
type Snapshot = { client: ChatAgentClient; identities: Record<string, string>; statuses: Record<string, BotRailStatus> };
const recipeIdentity = (agent: ChatAgent) => JSON.stringify(agent.recipeRef ? [agent.recipeRef.recipeId, agent.recipeRef.version] : null);

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => { document.removeEventListener("visibilitychange", listener); };
}
const documentVisible = () => document.visibilityState === "visible";
const serverVisible = () => false;

/** Host visibility is distinct from keyboard focus: visible split panes may poll. */
export function useBotRailVisibility(visible: boolean): boolean {
  return useSyncExternalStore(subscribeVisibility, documentVisible, serverVisible) && visible;
}

/** Read-only, bounded projection for every Chat rail. The client fences owner/runtime;
 * scope fences refresh completions; same-Bot evidence survives navigation while
 * shared reads coalesce with existing attention summaries. */
export function useBotRailStatuses(client: ChatAgentClient | undefined, agents: readonly ChatAgent[], scope?: string, active = true): Record<string, BotRailStatus> {
  const visible = useBotRailVisibility(active);
  const key = JSON.stringify(agents.slice(0, MAX_AGENTS).map(agent => ({ id: agent.id, recipe: Boolean(agent.recipeRef), identity: recipeIdentity(agent) })));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const activation = useRef(0);
  useEffect(() => {
    if (!client?.bots || !visible) return;
    const refreshToken = `rail-scope:${scope ?? ""}:activation:${++activation.current}`;
    const entries = JSON.parse(key) as { id: string; recipe: boolean; identity: string }[];
    const reads = botSummaryReads(client);
    let current = true;
    const isCurrent = () => current && documentVisible();
    let pending = false;
    const refresh = async (token?: string) => {
      if (pending || !isCurrent()) return;
      pending = true;
      const statuses: Record<string, BotRailStatus> = {};
      let index = 0;
      try {
        await Promise.all(Array.from({length: Math.min(4, entries.length)}, async () => {
          while (isCurrent() && index < entries.length) {
            const { id: agentId, recipe } = entries[index++]!;
            // Custom Bots have dedicated Chats but no recipe task/interaction API.
            // Keep their indicator neutral rather than inventing execution evidence.
            if (!recipe) { statuses[agentId] = BOT_RAIL_UNAVAILABLE; continue; }
            try {
              const chatId = await reads.directChat(agentId, token);
              if (!isCurrent()) return;
              if (!chatId) { statuses[agentId] = BOT_RAIL_IDLE; continue; }
              const [tasks, interactions] = await Promise.all([reads.tasks(chatId, token), reads.interactions(chatId, token)]);
              if (!isCurrent()) return;
              statuses[agentId] = botRailStatus(tasks.filter(task => task.agentId === agentId && task.chatId === chatId),
                interactions.filter(item => item.agentId === agentId && item.chatId === chatId), new Date().toISOString());
            } catch (error: unknown) {
              if (!isCurrent()) return;
              console.warn("[bots] Rail status unavailable:", error instanceof Error ? error.name : "UnknownError");
              statuses[agentId] = BOT_RAIL_UNAVAILABLE;
            }
          }
        }));
        if (isCurrent()) setSnapshot({client, identities: Object.fromEntries(entries.map(entry => [entry.id, entry.identity])), statuses});
      } finally { pending = false; }
    };
    void refresh(refreshToken);
    const focus = (event: FocusEvent) => { void refresh(`focus:${event.timeStamp}`); };
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, REFRESH_MS);
    window.addEventListener("focus", focus);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [client, key, scope, visible]);
  const available = visible && client?.bots;
  return Object.fromEntries(agents.map((agent, index) => {
    if (index >= MAX_AGENTS) return [agent.id, BOT_RAIL_UNAVAILABLE];
    const matching = available && snapshot?.client === client && snapshot.identities[agent.id] === recipeIdentity(agent);
    return [agent.id, matching ? snapshot.statuses[agent.id] ?? BOT_RAIL_UNAVAILABLE
      : available ? BOT_RAIL_LOADING : BOT_RAIL_UNAVAILABLE];
  }));
}
