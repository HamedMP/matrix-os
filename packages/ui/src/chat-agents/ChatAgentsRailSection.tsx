import type { StartAgentChat } from "./client.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatAgent } from "@matrix-os/contracts";
import type { ChatAgentClient } from "./client.js";
import { AgentAvatar } from "./AgentAvatar.js";
import { AGENT_RECIPE_COUNT, BOT_RECIPE_COUNT } from "./AgentRecipesPanel.js";
import { useChatAgentsNavigation } from "./ChatAgentsNavigation.js";
import { chatAgentMutedStyle } from "./theme.js";

export const CREATE_AGENT_CHAT_PROMPT = "Help me create an agent. Ask what work I want to delegate, suggest a focused role and capabilities, then create it with me through this Chat.";

const emptyIdeas = [
  ["Build a research scout", "Help me create an agent that researches a topic, checks sources, and returns a concise brief."],
  ["Build a daily planner", "Help me create an agent that turns my calendar and priorities into a practical daily plan."],
  ["Build a meeting follow-up agent", "Help me create an agent that turns meeting notes into decisions, owners, and follow-ups."],
] as const;

function RailGlyph({ children }: { children: ReactNode }) {
  return <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center text-[13px]">{children}</span>;
}

export function ChatAgentsRailSection({ client, onSetup, onOpen, onStartChat, onOpenBotChat }: {
  activeChatId?: string; client?: ChatAgentClient; onSetup?: () => void; onOpen?: () => void; onStartChat?: StartAgentChat; onOpenBotChat?: (chatId: string) => void | Promise<void>;
}) {
  const navigation = useChatAgentsNavigation();
  const [openingBot, setOpeningBot] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const openSequence = useRef(0);
  const opening = useRef(false);
  useEffect(() => {
    setOpeningBot(null);
    setOpenError(null);
    return () => { openSequence.current += 1; opening.current = false; };
  }, [client, navigation?.generation]);
  const [expanded, setExpanded] = useState(true);
  const [state, setState] = useState<{ client: ChatAgentClient; enabled: boolean; agents: ChatAgent[] } | null>(null);
  useEffect(() => {
    if (!client) return;
    let current = true;
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      void client.list().then((result) => {
      if (current) setState({ client, enabled: result.enabled, agents: result.agents });
    }).catch((failure: unknown) => {
      console.warn("[chat-agents] Rail unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setState({ client, enabled: false, agents: [] });
    }).finally(() => { pending = false; }); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 5_000);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [client, navigation?.opened]);
  if (!navigation || !client || state?.client !== client || !state.enabled) return null;
  const start: StartAgentChat | undefined = onStartChat
    ? (text, resources) => { navigation.close(); if (resources) onStartChat(text, resources); else onStartChat(text); }
    : undefined;
  const openAgent = async (agent: ChatAgent) => {
    setOpenError(null);
    if (!client.bots || !onOpenBotChat) {
      start?.("", [{ kind: "agent", id: agent.id, label: agent.name, revision: String(agent.revision) }]);
      return;
    }
    if (!client.bots || !onOpenBotChat || opening.current) return;
    opening.current = true;
    const sequence = ++openSequence.current;
    const navigationGeneration = navigation.getGeneration();
    const isCurrent = () => sequence === openSequence.current && navigation.getGeneration() === navigationGeneration;
    setOpeningBot(agent.id);
    try {
      const chatId = await client.bots.directChat(agent.id);
      if (!isCurrent()) return;
      if (!chatId) {
        if (agent.recipeRef) throw new Error("Missing bot chat binding");
        start?.("", [{ kind: "agent", id: agent.id, label: agent.name, revision: String(agent.revision) }]);
        return;
      }
      await onOpenBotChat(chatId);
      // The host may close Agents as part of this accepted navigation.
      onOpen?.();
      navigation.close();
    } catch (error: unknown) {
      console.warn("[chat-agents] Bot Chat unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (isCurrent()) setOpenError("Could not open this bot’s Chat. Try again.");
    } finally {
      if (sequence === openSequence.current) { opening.current = false; setOpeningBot(null); }
    }
  };
  return <section className="matrix-chat-agents-rail mb-1 flex flex-col gap-0.5">
    <div className="flex items-center">
      <button type="button" aria-label="Agents" aria-expanded={expanded} className="min-w-0 flex-1 rounded-sm px-2.5 pb-1 pt-2 text-left text-xs font-semibold uppercase tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" style={chatAgentMutedStyle} onClick={() => setExpanded((value) => !value)}>Agents</button>
      <button type="button" aria-label="Create an agent" disabled={!start} title="Create an agent" className="matrix-chat-agent-button grid size-6 place-items-center rounded-md text-lg font-light outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" style={chatAgentMutedStyle} onClick={() => start?.(CREATE_AGENT_CHAT_PROMPT)}>+</button>
      <button type="button" aria-label="Manage agents" title="Manage agents" className="matrix-chat-agent-button grid size-6 place-items-center rounded-md outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)]" style={chatAgentMutedStyle} onClick={(event) => { navigation.open({ client, onSetup, view: "library" }, event.currentTarget); onOpen?.(); }}>…</button>
    </div>
    {expanded ? <div className="matrix-chat-agents-rail__items flex flex-col gap-0.5">
      <button type="button" aria-label="Browse agent recipes" aria-pressed={navigation.opened?.client === client && navigation.opened.view === "recipes"} className="matrix-chat-agent-rail-row flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)] aria-pressed:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))]" onClick={(event) => { navigation.open({ client, onSetup, onStartChat: start, view: "recipes" }, event.currentTarget); onOpen?.(); }}><RailGlyph>✦</RailGlyph><span>Templates</span><span className="ml-auto text-[10px] tabular-nums" style={chatAgentMutedStyle}>{client?.bots ? BOT_RECIPE_COUNT : AGENT_RECIPE_COUNT}</span></button>
      {state.agents.map((agent) => <button key={agent.id} type="button" aria-label={`Chat with ${agent.name}`} aria-busy={openingBot === agent.id} disabled={openingBot !== null || (agent.recipeRef ? !client.bots || !onOpenBotChat : !start)} className="matrix-chat-agent-rail-row flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" onClick={() => { void openAgent(agent); }}><AgentAvatar id={agent.id} name={agent.name} size="small" /><span className="min-w-0 flex-1 truncate">{agent.name}</span></button>)}
      {!state.agents.length ? <div className="mx-2 mt-1 grid gap-1.5 rounded-xl border border-dashed p-2.5"><p className="text-[11px] font-medium">What should your first agent own?</p>{emptyIdeas.map(([label, prompt]) => <button key={label} type="button" aria-label={label} disabled={!start} className="rounded-md px-1.5 py-1 text-left text-[11px] leading-4 outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" style={chatAgentMutedStyle} onClick={() => start?.(prompt)}>{label}</button>)}</div> : null}
    </div> : null}
    {openError ? <p role="alert" className="px-2 text-xs">{openError}</p> : null}
  </section>;
}
