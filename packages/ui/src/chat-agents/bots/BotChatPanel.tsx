import type { BotAuthorityView, BotInteraction, BotTaskSummary } from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import type { ChatAgentClient } from "../client.js";
import { AgentAvatar } from "../AgentAvatar.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";
import { BotAuthorityPanel } from "./BotAuthorityPanel.js";
import { InteractionCard } from "./InteractionCard.js";
import { BotTaskStatus } from "./BotTaskStatus.js";

import { useDirectBotChat } from "./use-direct-bot-chat.js";

const REFRESH_INTERVAL_MS = 15_000;

/** Shared by Web Canvas and Web Desktop through ChatApp. */
export function BotChatPanel({ chatId, client, refreshKey, directBotId }: { chatId?: string; client?: ChatAgentClient; refreshKey?: number; directBotId?: string | null }) {
  const bots = client?.bots;
  const agentId = useDirectBotChat(chatId, client, directBotId);
  const [name, setName] = useState<string | null>(null);
  const [interactions, setInteractions] = useState<BotInteraction[]>([]);
  const [interactionsFresh, setInteractionsFresh] = useState(false);
  const [tasks, setTasks] = useState<BotTaskSummary[]>([]);
  const [authority, setAuthority] = useState<BotAuthorityView | null>(null);
  const [showAuthority, setShowAuthority] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
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
        if (library.status === "fulfilled") setName(library.value.agents.find((agent) => agent.id === agentId)?.name ?? null);
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
  if (!agentId || !chatId || !bots) return null;
  return <section aria-label="Bot controls" className="border-b px-3 py-2">
    <div className="mx-auto grid max-h-96 max-w-[720px] gap-3 overflow-y-auto">
      <div className="flex items-center gap-2">
        <AgentAvatar id={agentId} name={name ?? "Your bot"} />
        <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{name ?? "Your bot"}</p>
          <p className="text-xs" style={chatAgentMutedStyle}>Your bot's Chat</p></div>
        <button type="button" aria-label="Show bot authority" aria-expanded={showAuthority} className={chatAgentButtonClass}
          onClick={() => setShowAuthority((value) => !value)}>Access &amp; memory</button>
      </div>
      {interactions.map((interaction) => <InteractionCard key={interaction.interactionId} interaction={interaction}
        actionsAvailable={interactionsFresh}
        onResolve={(input) => bots.resolve(chatId, interaction.interactionId, input)} onResolved={() => setTick((value) => value + 1)}
        />)}
      {tasks.map((task) => <BotTaskStatus key={task.taskId} task={task} />)}
      {showAuthority && authority ? <BotAuthorityPanel view={authority}
        onRevoke={(grantId) => bots.revoke(agentId, grantId)}
        onMemory={(itemId, action, input) => bots.memory(agentId, itemId, action, input)}
        onChanged={() => setTick((value) => value + 1)} /> : null}
      {error ? <p role="alert" className="text-xs">{error}</p> : null}
    </div>
  </section>;
}
