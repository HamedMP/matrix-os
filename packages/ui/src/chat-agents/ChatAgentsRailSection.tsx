import type { StartAgentChat } from "./client.js";
import { useEffect, useRef, useState } from "react";
import type { ChatAgent } from "@matrix-os/contracts";
import type { ChatAgentClient } from "./client.js";
import { useBotRailStatuses, useBotRailVisibility } from "./bots/use-bot-rail-statuses.js";
import { AgentAvatar } from "./AgentAvatar.js";
import { useChatAgentsNavigation } from "./ChatAgentsNavigation.js";

export const CREATE_AGENT_CHAT_PROMPT = "Help me create an agent. Ask what work I want to delegate, suggest a focused role and capabilities, then create it with me through this Chat.";

export function ChatAgentsRailSection({ activeChatId, client, visible = true, onSetup, onOpen, onStartChat, onOpenBotChat }: {
  /** Actual rail visibility, including retained tabs and collapsed host sidebars. */
  visible?: boolean;
  activeChatId?: string; client?: ChatAgentClient; onSetup?: () => void; onOpen?: () => void; onStartChat?: StartAgentChat; onOpenBotChat?: (chatId: string) => void | Promise<void>;
}) {
  const navigation = useChatAgentsNavigation();
  const active = useBotRailVisibility(visible) && Boolean(navigation);
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
    if (!client || !active) return;
    let current = true;
    let pending = false;
    const refresh = () => {
      if (pending || !current || document.visibilityState !== "visible") return;
      pending = true;
      void client.list().then((result) => {
      if (current && document.visibilityState === "visible") setState({ client, enabled: result.enabled, agents: result.agents });
    }).catch((failure: unknown) => {
      console.warn("[chat-agents] Rail unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (current && document.visibilityState === "visible") setState({ client, enabled: false, agents: [] });
    }).finally(() => { pending = false; }); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 5_000);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [client, navigation?.opened, active]);
  const visibleAgents = state && state.client === client && state.enabled ? state.agents : [];
  const statuses = useBotRailStatuses(client, visibleAgents, `${activeChatId ?? ""}:${navigation?.generation ?? 0}`, expanded && active);
  if (!navigation || !client || state?.client !== client || !state.enabled) return null;
  const start: StartAgentChat | undefined = onStartChat
    ? (text, resources) => { navigation.close(); if (resources) onStartChat(text, resources); else onStartChat(text); }
    : undefined;
  const openAgent = async (agent: ChatAgent) => {
    setOpenError(null);
    if (!client.bots || !onOpenBotChat) {
      setOpenError("Could not open this bot’s Chat. Try again.");
      return;
    }
    if (!client.bots || !onOpenBotChat || opening.current) return;
    opening.current = true;
    const sequence = ++openSequence.current;
    const navigationGeneration = navigation.getGeneration();
    const isCurrent = () => sequence === openSequence.current && navigation.getGeneration() === navigationGeneration;
    setOpeningBot(agent.id);
    try {
      const boundChatId = await client.bots.ensureDirectChat(agent.id);
      if (!isCurrent()) return;
      const chatId = boundChatId;
      if (!chatId) throw new Error("Missing bot chat binding");
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
  return <section className="matrix-chat-agents-rail mb-1 flex shrink-0 flex-col gap-0.5">
    <div data-slot="chat-sidebar-section-heading" className="flex items-center">
      <button type="button" aria-label="Agents" aria-pressed={navigation.opened?.client === client && navigation.opened.view === "library"} className="matrix-chat-agents-heading flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-0 text-left outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]" style={{color:"var(--matrix-chat-rail-text, var(--text-primary, var(--foreground)))"}} onClick={event => { navigation.open({ client, onSetup, view: "library" }, event.currentTarget); onOpen?.(); }}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg><span>Agents</span></button>
      <button type="button" aria-label="Add new agent" title="New agent" className="matrix-chat-agents-create grid h-8 w-7 shrink-0 place-items-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]" onClick={event => { navigation.open({ client, onSetup, onStartChat: start, view: "recipes" }, event.currentTarget); onOpen?.(); }}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button>
      <button type="button" aria-label={expanded ? "Collapse agents" : "Expand agents"} aria-expanded={expanded} className="matrix-chat-agent-button grid h-7 w-8 shrink-0 place-items-center py-0 rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]" style={{color:"var(--text-tertiary, var(--matrix-muted-fg, var(--muted-foreground)))"}} onClick={() => setExpanded(value => !value)}><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" className={`transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}><path d="M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
    </div>
    <div aria-hidden={!expanded} inert={!expanded} data-slot="chat-rail-collapse" data-expanded={expanded} className="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none" style={{gridTemplateRows:expanded ? "1fr" : "0fr",opacity:expanded ? 1 : 0}}><div className="min-h-0 overflow-hidden"><div className="matrix-chat-agents-rail__items flex flex-col gap-0.5">
      {state.agents.map((agent) => <button key={agent.id} data-agent-rail-state={statuses[agent.id]?.state} type="button" aria-label={`Chat with ${agent.name}`} aria-busy={openingBot === agent.id} disabled={openingBot !== null || (!client.bots || !onOpenBotChat)} className="matrix-chat-agent-rail-row flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" onClick={() => { void openAgent(agent); }}><AgentAvatar id={agent.id} name={agent.name} size="small" /><span className="matrix-chat-agent-rail-copy min-w-0 flex-1"><span data-slot="chat-agent-name" className="matrix-chat-agent-rail-name truncate">{agent.name}</span><span data-slot="chat-agent-status" className="matrix-chat-agent-rail-status truncate">{statuses[agent.id]?.label}</span></span><span aria-hidden="true" data-slot="chat-agent-indicator" className="matrix-chat-agent-rail-indicator" data-state={statuses[agent.id]?.state} /></button>)}
    </div></div></div>
    {openError ? <p role="alert" className="px-2 text-xs">{openError}</p> : null}
  </section>;
}
