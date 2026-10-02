import type { BotAuthorityView, BotInteraction, BotTaskSummary, CanonicalProviderCatalog, CanonicalChatModelSelection, ChatAgent } from "@matrix-os/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBotDetailsHost } from "./use-bot-details-host.js";
import type { ChatAgentClient } from "../client.js";
import { AgentAvatar } from "../AgentAvatar.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";
import { BotEditDialog } from "./BotEditDialog.js";
import { BotDetailsPanel } from "./BotDetailsPanel.js";
import { InteractionCard } from "./InteractionCard.js";
import { BotTaskStatus } from "./BotTaskStatus.js";

import { useDirectBotChat } from "./use-direct-bot-chat.js";

const REFRESH_INTERVAL_MS = 15_000;

interface BotChatPanelProps {
  chatId?: string;
  client?: ChatAgentClient;
  refreshKey?: number;
  directBotId?: string | null;
  catalog?: CanonicalProviderCatalog | null;
  catalogLoading?: boolean;
  detailsContainer?: HTMLElement | null;
  headerContainer?: HTMLElement | null;
  headerLeading?: ReactNode;
  headerActions?: ReactNode;
}

/** Shared by Web Canvas and Web Desktop through ChatApp. */
export function BotChatPanel({ chatId, client, refreshKey, directBotId, catalog, catalogLoading = false, detailsContainer, headerContainer, headerLeading, headerActions }: BotChatPanelProps) {
  const bots = client?.bots;
  const agentId = useDirectBotChat(chatId, client, directBotId);
  const [agent, setAgent] = useState<ChatAgent | null>(null);
  const [modelPending, setModelPending] = useState(false);
  const selectionSequence = useRef(0);
  const latestRevision = useRef(-1);
  const [showEdit, setShowEdit] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [interactions, setInteractions] = useState<BotInteraction[]>([]);
  const [interactionsFresh, setInteractionsFresh] = useState(false);
  const [tasks, setTasks] = useState<BotTaskSummary[]>([]);
  const [authority, setAuthority] = useState<BotAuthorityView | null>(null);
  const [showAuthority, setShowAuthority] = useState(false);
  useBotDetailsHost(detailsContainer, showAuthority);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    selectionSequence.current += 1;
    latestRevision.current = -1;
    setAgent(null);
    setModelPending(false);
    setShowEdit(false);
    setInteractions([]);
    setInteractionsFresh(false);
    setTasks([]);
    setAuthority(null);
    setName(null);
    setShowAuthority(false);
    setError("");
  }, [chatId, bots, agentId]);
  useEffect(() => {
    if (!agentId || !chatId || !bots || !client) return;
    let current = true;
    const refresh = async () => {
      try {
        const [pending, activeTasks, view, library] = await Promise.allSettled([
          bots.interactions(chatId), bots.tasks(chatId), bots.authority(agentId), client.list(),
        ]);
        if (!current) return;
        if (pending.status === "fulfilled") setInteractions(pending.value);
        setInteractionsFresh(pending.status === "fulfilled");
        if (activeTasks.status === "fulfilled") setTasks(activeTasks.value);
        if (view.status === "fulfilled") setAuthority(view.value);
        if (library.status === "fulfilled") {
          const agent = library.value.agents.find((candidate) => candidate.id === agentId);
          if (agent && agent.revision >= latestRevision.current) {
            latestRevision.current = agent.revision; setAgent(agent); setName(agent.name);
          }
        }
        if (library.status === "rejected") console.warn("[chat-agents] Bot name unavailable:", library.reason instanceof Error ? library.reason.name : "UnknownError");
        setError(pending.status === "rejected" || activeTasks.status === "rejected" || view.status === "rejected"
          ? "Bot status could not be loaded. Try again." : "");
      } catch (failure: unknown) {
        console.warn("[chat-agents] Bot status unavailable:", failure instanceof Error ? failure.name : "UnknownError");
        if (current) {
          setInteractionsFresh(false);
          setError("Bot status could not be loaded. Try again.");
        }
      }
    };
    void refresh();
    const timer = setInterval(() => setTick((value) => value + 1), REFRESH_INTERVAL_MS);
    return () => { current = false; clearInterval(timer); };
  }, [agentId, chatId, bots, client, tick, refreshKey]);
  const changeModel = async (selection: CanonicalChatModelSelection) => {
    if (!agent || !client || modelPending || catalogLoading) return;
    const sequence = ++selectionSequence.current;
    setModelPending(true); setError("");
    try {
      const updated = await client.update(agent.id, { selection, baseRevision: agent.revision });
      if (selectionSequence.current !== sequence) return;
      latestRevision.current = updated.revision;
      setAgent(updated);
    } catch (failure: unknown) {
      console.warn("[bots] Model change unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (selectionSequence.current === sequence) setError("Could not change the bot model. Refresh and try again.");
    } finally { if (selectionSequence.current === sequence) setModelPending(false); }
  };
  if (!agentId || !chatId || !bots) return null;
  const details = showAuthority ? <BotDetailsPanel agent={agent} agentId={agentId} authority={authority} bots={bots} catalog={catalog} catalogLoading={catalogLoading} pending={modelPending}
    hosted={Boolean(detailsContainer)} onModelChange={selection => { void changeModel(selection); }} onClose={() => setShowAuthority(false)} onEdit={() => setShowEdit(true)} onChanged={() => setTick(value => value + 1)}/> : null;
  const identity = <div className="matrix-bot-identity-bar flex min-w-0 items-center gap-3 px-3 py-1" data-hosted={headerContainer ? "true" : undefined}>
      {headerLeading}
      <AgentAvatar id={agentId} name={name ?? "Your bot"} size="small" />
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{name ?? "Your bot"}</p>
        <p className="truncate text-xs" style={chatAgentMutedStyle}>{agent ? agent.description || "Bot chat" : "Loading agent details…"}</p></div>
      <button type="button" aria-label="Details" aria-expanded={showAuthority} className={`${chatAgentButtonClass} shrink-0`}
        onClick={() => setShowAuthority(value => !value)}>Details</button>
      {headerActions}
    </div>;
  return <section aria-label="Bot controls" className="matrix-bot-chat-header" data-bot-header>
    {headerContainer ? createPortal(identity, headerContainer) : identity}
    <div className="matrix-bot-status-content">
      {interactions.filter(interaction => interaction.status === "pending").map((interaction) => <InteractionCard key={interaction.interactionId} interaction={interaction}
        actionsAvailable={interactionsFresh}
        onResolve={(input) => bots.resolve(chatId, interaction.interactionId, input)} onResolved={() => setTick((value) => value + 1)}
        />)}
      {tasks.map((task) => <BotTaskStatus key={task.taskId} task={task} />)}
      {details && detailsContainer ? createPortal(details, detailsContainer) : details}
      {showEdit && agent && client ? <BotEditDialog key={agent.id} agent={agent} client={client} catalog={catalog} catalogLoading={catalogLoading} authority={authority} onClose={() => setShowEdit(false)} onSaved={updated => { latestRevision.current = updated.revision; setAgent(updated); setName(updated.name); }}/>:null}
      {error ? <p role="alert" className="text-xs">{error}</p> : null}
    </div>
  </section>;
}
