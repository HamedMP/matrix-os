import type { StartAgentChat } from "./client.js";
import { useEffect, useState, type ReactNode } from "react";
import type { ChatAgent } from "@matrix-os/contracts";
import type { ChatAgentClient } from "./client.js";
import { AgentAvatar } from "./AgentAvatar.js";
import { AGENT_RECIPE_COUNT } from "./AgentRecipesPanel.js";
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

export function ChatAgentsRailSection({ client, onSetup, onOpen, onStartChat }: {
  client?: ChatAgentClient; onSetup?: () => void; onOpen?: () => void; onStartChat?: StartAgentChat;
}) {
  const navigation = useChatAgentsNavigation();
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
  return <section className="matrix-chat-agents-rail mb-1 flex flex-col gap-0.5">
    <div className="flex items-center">
      <button type="button" aria-label="Agents" aria-expanded={expanded} className="min-w-0 flex-1 rounded-sm px-2.5 pb-1 pt-2 text-left text-xs font-semibold uppercase tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" style={chatAgentMutedStyle} onClick={() => setExpanded((value) => !value)}>Agents</button>
      <button type="button" aria-label="Create an agent" disabled={!start} title="Create an agent" className="matrix-chat-agent-button grid size-6 place-items-center rounded-md text-lg font-light outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" style={chatAgentMutedStyle} onClick={() => start?.(CREATE_AGENT_CHAT_PROMPT)}>+</button>
      <button type="button" aria-label="Manage agents" title="Manage agents" className="matrix-chat-agent-button grid size-6 place-items-center rounded-md outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)]" style={chatAgentMutedStyle} onClick={(event) => { navigation.open({ client, onSetup, view: "library" }, event.currentTarget); onOpen?.(); }}>…</button>
    </div>
    {expanded ? <div className="matrix-chat-agents-rail__items flex flex-col gap-0.5">
      <button type="button" aria-label="Browse agent recipes" aria-pressed={navigation.opened?.client === client && navigation.opened.view === "recipes"} className="matrix-chat-agent-rail-row flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)] aria-pressed:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))]" onClick={(event) => { navigation.open({ client, onSetup, onStartChat: start, view: "recipes" }, event.currentTarget); onOpen?.(); }}><RailGlyph>✦</RailGlyph><span>Recipes</span><span className="ml-auto text-[10px] tabular-nums" style={chatAgentMutedStyle}>{AGENT_RECIPE_COUNT}</span></button>
      {state.agents.map((agent) => <button key={agent.id} type="button" aria-label={`Chat with ${agent.name}`} disabled={!start} className="matrix-chat-agent-rail-row flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" onClick={() => start?.("", [{ kind: "agent", id: agent.id, label: agent.name, revision: String(agent.revision) }])}><AgentAvatar id={agent.id} name={agent.name} size="small" /><span className="min-w-0 flex-1 truncate">{agent.name}</span><span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" /></button>)}
      {!state.agents.length ? <div className="mx-2 mt-1 grid gap-1.5 rounded-xl border border-dashed p-2.5"><p className="text-[11px] font-medium">What should your first agent own?</p>{emptyIdeas.map(([label, prompt]) => <button key={label} type="button" aria-label={label} disabled={!start} className="rounded-md px-1.5 py-1 text-left text-[11px] leading-4 outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" style={chatAgentMutedStyle} onClick={() => start?.(prompt)}>{label}</button>)}</div> : null}
    </div> : null}
  </section>;
}
