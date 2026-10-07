import { ChevronRight, Plus, Sparkle } from "lucide-react";
import type { StartAgentChat } from "./client.js";
import { useEffect, useRef, useState } from "react";
import type { ChatAgent } from "@matrix-os/contracts";
import type { ChatAgentClient } from "./client.js";
import { useBotRailStatuses, useBotRailVisibility } from "./bots/use-bot-rail-statuses.js";
import { ChatAgentRailRow } from "./ChatAgentRailRow.js";
import { useAgentRailLibrary } from "./bots/use-agent-rail-library.js";
import { useChatAgentsNavigation } from "./ChatAgentsNavigation.js";

export const CREATE_AGENT_CHAT_PROMPT = "Help me create an agent. Ask what work I want to delegate, suggest a focused role and capabilities, then create it with me through this Chat.";

export function ChatAgentsRailSection({ activeChatId, client, visible = true, onSetup, onOpen, onStartChat, onOpenBotChat, expanded: controlledExpanded, onExpandedChange, activeAgentId, menuZIndex = 100 }: {
  /** Hosts supply an authenticated binding and scoped presentation preferences. */
  menuZIndex?: number; activeAgentId?: string | null; expanded?: boolean; onExpandedChange?: (expanded: boolean) => void;
  /** Actual rail visibility, including retained tabs and collapsed host sidebars. */
  visible?: boolean;
  activeChatId?: string; client?: ChatAgentClient; onSetup?: () => void; onOpen?: () => void; onStartChat?: StartAgentChat; onOpenBotChat?: (chatId: string) => void | Promise<void>;
}) {
  const navigation = useChatAgentsNavigation();
  const active = useBotRailVisibility(visible) && Boolean(navigation);
  const [openingBot, setOpeningBot] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const currentChatId = useRef(activeChatId);
  currentChatId.current = activeChatId;
  const currentClient = useRef(client);
  currentClient.current = client;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const openSequence = useRef(0);
  const opening = useRef(false);
  useEffect(() => {
    setOpeningBot(null);
    setOpenError(null);
    return () => { openSequence.current += 1; opening.current = false; };
  }, [client, navigation?.generation]);
  const [localDisclosure, setLocalDisclosure] = useState(() => ({client, expanded: true}));
  let local = localDisclosure;
  if (local.client !== client) { local = {client, expanded: true}; setLocalDisclosure(local); }
  const expanded = controlledExpanded ?? local.expanded;
  const toggleExpanded = () => { setLocalDisclosure({client, expanded: !expanded}); onExpandedChange?.(!expanded); };
  const state = useAgentRailLibrary(client, active, navigation?.opened);
  const visibleAgents = state?.enabled ? state.agents : [];
  const statuses = useBotRailStatuses(client, visibleAgents, `${activeChatId ?? ""}:${navigation?.generation ?? 0}`, expanded && active);
  if (!navigation || !client || !state?.enabled) return null;
  const start: StartAgentChat | undefined = onStartChat
    ? (text, resources) => { navigation.close(); if (resources) onStartChat(text, resources); else onStartChat(text); }
    : undefined;
  const openAgent = async (agent: ChatAgent, details = false) => {
    setOpenError(null);
    if (!client.bots || !onOpenBotChat) {
      setOpenError("Could not open this bot’s Chat. Try again.");
      return;
    }
    if (!client.bots || !onOpenBotChat || opening.current) return;
    opening.current = true;
    const sequence = ++openSequence.current;
    const navigationGeneration = navigation.getGeneration();
    const sourceChatId = activeChatId;
    const isCurrent = () => sequence === openSequence.current && navigation.getGeneration() === navigationGeneration && currentChatId.current === sourceChatId;
    setOpeningBot(agent.id);
    try {
      const boundChatId = await client.bots.ensureDirectChat(agent.id);
      if (!isCurrent()) return;
      const chatId = boundChatId;
      if (!chatId) throw new Error("Missing bot chat binding");
      const hostTransition = onOpenBotChat(chatId);
      // The accepted host callback can synchronously close Agents. Capture that
      // generation, then reject any newer navigation while its promise settles.
      const acceptedGeneration = navigation.getGeneration();
      await hostTransition;
      if (!mounted.current || currentClient.current !== client || navigation.getGeneration() !== acceptedGeneration) return;
      // A different Chat accepted during the host transition must not get this request.
      if (currentChatId.current !== sourceChatId && currentChatId.current !== chatId) return;
      // The host may close Agents as part of this accepted navigation.
      onOpen?.();
      navigation.close();
      if (details && sequence === openSequence.current) navigation.requestDetails(client, chatId, agent.id);
    } catch (error: unknown) {
      console.warn("[chat-agents] Bot Chat unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (isCurrent()) setOpenError("Could not open this bot’s Chat. Try again.");
    } finally {
      if (sequence === openSequence.current) { opening.current = false; setOpeningBot(null); }
    }
  };
  return <section className="matrix-chat-agents-rail mb-1 flex shrink-0 flex-col gap-0.5">
    <div data-slot="chat-sidebar-section-heading" className="matrix-chat-agents-group-heading">
      <button type="button" aria-label="Agents" aria-pressed={navigation.opened?.client === client && navigation.opened.view === "library"} className="matrix-chat-agents-heading" onClick={event => { navigation.open({ client, onSetup, view: "library" }, event.currentTarget); onOpen?.(); }}><Sparkle aria-hidden="true" size={15} strokeWidth={1.5}/><span>Agents</span></button>
      <button type="button" aria-label={expanded ? "Collapse agents" : "Expand agents"} aria-expanded={expanded} className="matrix-chat-agents-disclosure" onClick={toggleExpanded}><ChevronRight aria-hidden="true" size={12} strokeWidth={1.5} className={`transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}/></button>
      <span className="matrix-chat-agents-heading-spacer" />
      {!expanded && visibleAgents.length > 0 ? <span className="matrix-chat-agents-count" aria-label={`${visibleAgents.length} ${visibleAgents.length === 1 ? "agent" : "agents"}`}>{visibleAgents.length}</span> : null}
      <button type="button" aria-label="Add new agent" title="New agent" className="matrix-chat-agents-create" onClick={event => { navigation.open({ client, onSetup, onStartChat: start, view: "recipes" }, event.currentTarget); onOpen?.(); }}><Plus aria-hidden="true" size={16} strokeWidth={1.5}/></button>
    </div>
    <div aria-hidden={!expanded} inert={!expanded} data-slot="chat-rail-collapse" data-expanded={expanded} className="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none" style={{gridTemplateRows:expanded ? "1fr" : "0fr",opacity:expanded ? 1 : 0}}><div className="min-h-0 overflow-hidden"><div className="matrix-chat-agents-rail__items flex flex-col gap-0.5">
      {state.agents.map(agent => <ChatAgentRailRow key={agent.id} agent={agent} status={statuses[agent.id]}
        menuZIndex={menuZIndex} current={activeAgentId === agent.id && !navigation.opened} opening={openingBot === agent.id}
        disabled={openingBot !== null || !client.bots || !onOpenBotChat} onOpen={details => { void openAgent(agent, details); }}/>) }
    </div></div></div>
    {openError ? <p role="alert" className="px-2 text-xs">{openError}</p> : null}
  </section>;
}
