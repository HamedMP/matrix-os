import type { BotAuthorityView, BotInteraction, BotTaskSummary } from "@matrix-os/contracts";
import { useEffect, useState, useRef, useId, type ReactNode } from "react";
import type { ChatAgentClient } from "../client.js";
import { AgentAvatar } from "../AgentAvatar.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";
import { BotSettingsLayout } from "./BotSettingsLayout.js";
import { BotAuthorityPanel } from "./BotAuthorityPanel.js";
import { InteractionCard } from "./InteractionCard.js";
import { BotTaskStatus } from "./BotTaskStatus.js";

import { useDirectBotChat } from "./use-direct-bot-chat.js";

const REFRESH_INTERVAL_MS = 15_000;

/** Shared by Web Canvas and Web Desktop through ChatApp. */
export function BotChatPanel({ chatId, client, refreshKey, directBotId, children }: { chatId?: string; client?: ChatAgentClient; refreshKey?: number; directBotId?: string | null; children?: ReactNode }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [authorityFresh, setAuthorityFresh] = useState(false);
  const [authorityLoading, setAuthorityLoading] = useState(true);
  const bots = client?.bots;
  const agentId = useDirectBotChat(chatId, client, directBotId);
  const currentScope = useRef({ chatId, bots, agentId });
  useEffect(() => { currentScope.current = { chatId, bots, agentId }; }, [chatId, bots, agentId]);
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
    setAuthorityFresh(false);
    setAuthorityLoading(true);
    setName(null);
    setShowAuthority(false);
    setError("");
  }, [chatId, bots, agentId]);
  useEffect(() => {
    if (!agentId || !chatId || !bots || !client) return;
    let current = true;
    const refresh = async () => {
      setAuthorityLoading(true);
      try {
        const [pending, activeTasks, view, library] = await Promise.allSettled([
          bots.interactions(chatId), bots.tasks(chatId), bots.authority(agentId), client.list(),
        ]);
        if (!current) return;
        if (pending.status === "fulfilled") setInteractions(pending.value);
        setInteractionsFresh(pending.status === "fulfilled");
        if (activeTasks.status === "fulfilled") setTasks(activeTasks.value);
        if (view.status === "fulfilled") setAuthority(view.value);
        setAuthorityFresh(view.status === "fulfilled");
        setAuthorityLoading(false);
        if (library.status === "fulfilled") setName(library.value.agents.find((agent) => agent.id === agentId)?.name ?? null);
        if (library.status === "rejected") console.warn("[chat-agents] Bot name unavailable:", library.reason instanceof Error ? library.reason.name : "UnknownError");
        setError(pending.status === "rejected" || activeTasks.status === "rejected" || view.status === "rejected"
          ? "Bot status could not be loaded. Try again." : "");
      } catch (failure: unknown) {
        console.warn("[chat-agents] Bot status unavailable:", failure instanceof Error ? failure.name : "UnknownError");
        if (current) {
          setInteractionsFresh(false);
          setAuthorityFresh(false);
          setAuthorityLoading(false);
          setError("Bot status could not be loaded. Try again.");
        }
      }
    };
    void refresh();
    const timer = setInterval(() => setTick((value) => value + 1), REFRESH_INTERVAL_MS);
    return () => { current = false; clearInterval(timer); };
  }, [agentId, chatId, bots, client, tick, refreshKey]);
  const active = !!agentId && !!chatId && !!bots;
  return <BotSettingsLayout open={active && showAuthority} onClose={() => setShowAuthority(false)} triggerRef={triggerRef} panelId={panelId}
    settings={<>
      {!authorityFresh ? <div className="px-5 pb-4" role="status"><p className="text-xs" style={chatAgentMutedStyle}>{authorityLoading ? "Loading settings…" : "Settings couldn't be refreshed. Try again."}</p>
        {!authorityLoading ? <button type="button" className={`${chatAgentButtonClass} mt-3`} aria-label="Retry settings" onClick={() => setTick((value) => value + 1)}>Retry</button> : null}</div> : null}
      {authority && authority.agentId === agentId && bots && agentId ? <BotAuthorityPanel key={`${chatId}:${agentId}`} view={authority} actionsAvailable={authorityFresh}
        onRevoke={(grantId) => bots.revoke(agentId, grantId)}
        onMemory={(itemId, action, input) => bots.memory(agentId, itemId, action, input)}
        onConfirmedChange={(apply) => {
          const scope = currentScope.current;
          if (scope.chatId !== chatId || scope.bots !== bots || scope.agentId !== agentId) return;
          setAuthority((value) => value?.agentId === agentId ? apply(value) : value);
        }}
        onChanged={() => {
          const scope = currentScope.current;
          if (scope.chatId === chatId && scope.bots === bots && scope.agentId === agentId) setTick((value) => value + 1);
        }} /> : null}
    </>}>
    {active ? <section aria-label="Bot controls" className="shrink-0 border-b px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <AgentAvatar id={agentId} name={name ?? "Your bot"} size="small" />
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{name ?? "Your bot"}</p>
          <p className="text-xs" style={chatAgentMutedStyle}>Your bot's Chat</p></div>
        <button ref={triggerRef} type="button" aria-label="Bot settings" aria-expanded={showAuthority} aria-controls={panelId}
          className={`${chatAgentButtonClass} flex items-center gap-1.5 !px-2.5 !py-1.5 !text-xs`}
          onClick={() => setShowAuthority((value) => !value)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></svg>
          Settings
        </button>
      </div>
      {interactions.length || tasks.length ? <div className="mx-auto mt-3 grid max-h-52 max-w-[720px] gap-2 overflow-y-auto">
        {interactions.map((interaction) => <InteractionCard key={interaction.interactionId} interaction={interaction}
          actionsAvailable={interactionsFresh} onResolve={(input) => bots.resolve(chatId, interaction.interactionId, input)}
          onResolved={() => setTick((value) => value + 1)} />)}
        {tasks.map((task) => <BotTaskStatus key={task.taskId} task={task} />)}
      </div> : null}
      {error ? <p role="alert" className="mt-2 text-xs">{error}</p> : null}
    </section> : null}
    {children}
  </BotSettingsLayout>;
}
