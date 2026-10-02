import { botModelRoutingLabel } from "@matrix-os/contracts";
import type { BotAuthorityView, BotInteraction, BotTaskSummary, CanonicalProviderCatalog, CanonicalChatModelSelection, ChatAgent } from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import type { ChatAgentClient } from "../client.js";
import { AgentAvatar } from "../AgentAvatar.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";
import { BotEditDialog } from "./BotEditDialog.js";
import { BotDetailsPanel } from "./BotDetailsPanel.js";
import { MatrixBotModelField } from "./MatrixBotModelField.js";
import { deriveCanonicalProviderChoices } from "../../canonical-provider-choice.js";
import { InteractionCard } from "./InteractionCard.js";
import { BotTaskStatus } from "./BotTaskStatus.js";

import { useDirectBotChat } from "./use-direct-bot-chat.js";

const REFRESH_INTERVAL_MS = 15_000;

/** Shared by Web Canvas and Web Desktop through ChatApp. */
export function BotChatPanel({ chatId, client, refreshKey, directBotId, catalog, catalogLoading = false }: { chatId?: string; client?: ChatAgentClient; refreshKey?: number; directBotId?: string | null; catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean }) {
  const bots = client?.bots;
  const agentId = useDirectBotChat(chatId, client, directBotId);
  const [agent, setAgent] = useState<ChatAgent | null>(null);
  const [modelPending, setModelPending] = useState(false);
  const selectionSequence = useRef(0);
  const latestRevision = useRef(-1);
  const [showEdit, setShowEdit] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [modelSelection, setModelSelection] = useState<{ selection: CanonicalChatModelSelection | null } | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [interactions, setInteractions] = useState<BotInteraction[]>([]);
  const [interactionsFresh, setInteractionsFresh] = useState(false);
  const [tasks, setTasks] = useState<BotTaskSummary[]>([]);
  const [authority, setAuthority] = useState<BotAuthorityView | null>(null);
  const [showAuthority, setShowAuthority] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    selectionSequence.current += 1;
    latestRevision.current = -1;
    setAgent(null);
    setModelPending(false);
    setShowModels(false);
    setShowEdit(false);
    setInteractions([]);
    setInteractionsFresh(false);
    setTasks([]);
    setAuthority(null);
    setName(null);
    setModelSelection(null);
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
            setModelSelection({ selection: agent.selection ?? null });
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
  const modelRouting = botModelRoutingLabel(modelSelection ? modelSelection.selection : undefined, catalog);
  const changeModel = async (selection: CanonicalChatModelSelection) => {
    if (!agent || !client || modelPending || catalogLoading) return;
    const sequence = ++selectionSequence.current;
    setModelPending(true); setError("");
    try {
      const updated = await client.update(agent.id, { selection, baseRevision: agent.revision });
      if (selectionSequence.current !== sequence) return;
      latestRevision.current = updated.revision;
      setAgent(updated); setModelSelection({ selection: updated.selection }); setShowModels(false);
    } catch (failure: unknown) {
      console.warn("[bots] Model change unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (selectionSequence.current === sequence) setError("Could not change the bot model. Refresh and try again.");
    } finally { if (selectionSequence.current === sequence) setModelPending(false); }
  };
  if (!agentId || !chatId || !bots) return null;
  return <section aria-label="Bot controls" className="matrix-bot-chat-header border-b px-4 py-3">
    <div className="mx-auto grid max-w-[720px] gap-3">
      <div className="flex items-center gap-2">
        <AgentAvatar id={agentId} name={name ?? "Your bot"} />
        <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{name ?? "Your bot"}</p>
          <p className="text-xs" style={chatAgentMutedStyle}>Persistent history</p><p className="text-xs" style={chatAgentMutedStyle}>Model: {modelRouting}</p></div>
        <button type="button" aria-label="Choose bot model" aria-expanded={showModels} className={chatAgentButtonClass} disabled={!agent || modelPending || catalogLoading}
          onClick={() => setShowModels(value => !value)}>Model</button>
        <button type="button" aria-label="Details" aria-expanded={showAuthority} className={chatAgentButtonClass}
          onClick={() => setShowAuthority((value) => !value)}>Details</button>
      </div>
      {showModels && agent ? <MatrixBotModelField label="Bot model" selection={agent.selection} models={catalog ? deriveCanonicalProviderChoices(catalog) : []} catalog={catalog} catalogLoading={catalogLoading} pending={modelPending || !catalog} onChange={selection => { void changeModel(selection); }}/> : null}
      {interactions.filter(interaction => interaction.status === "pending").map((interaction) => <InteractionCard key={interaction.interactionId} interaction={interaction}
        actionsAvailable={interactionsFresh}
        onResolve={(input) => bots.resolve(chatId, interaction.interactionId, input)} onResolved={() => setTick((value) => value + 1)}
        />)}
      {tasks.map((task) => <BotTaskStatus key={task.taskId} task={task} />)}
      {showAuthority ? <BotDetailsPanel agent={agent} agentId={agentId} authority={authority} bots={bots} catalog={catalog} catalogLoading={catalogLoading} pending={modelPending}
        onModelChange={selection => { void changeModel(selection); }} onClose={() => setShowAuthority(false)} onEdit={() => setShowEdit(true)} onChanged={() => setTick(value => value + 1)}/> : null}
      {showEdit && agent && client ? <BotEditDialog key={agent.id} agent={agent} client={client} catalog={catalog} catalogLoading={catalogLoading} onClose={() => setShowEdit(false)} onSaved={updated => { latestRevision.current = updated.revision; setAgent(updated); setName(updated.name); setModelSelection({ selection:updated.selection }); }}/>:null}
      {error ? <p role="alert" className="text-xs">{error}</p> : null}
    </div>
  </section>;
}
