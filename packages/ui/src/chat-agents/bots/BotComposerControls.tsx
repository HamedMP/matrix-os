import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { botModelRoutingLabel, type CanonicalChatModelSelection, type CanonicalProviderCatalog, type ChatAgent } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../client.js";
import { AgentAvatar } from "../AgentAvatar.js";
import { deriveCanonicalProviderChoices } from "../../canonical-provider-choice.js";
import { isAutomaticBotSelection, MatrixBotModelField } from "./MatrixBotModelField.js";
import { chatAgentMutedStyle } from "../theme.js";

/** The bound Bot's saved model is independent of an ordinary Chat's provider selection. */
export function BotComposerControls({ agentId, client, catalog, catalogLoading = false, disabled = false, refreshKey, onChanged, onSetup, onRefreshCatalog, zIndex = 50 }: {
  onSetup?: () => void; onRefreshCatalog?: () => void;
  agentId: string; client?: ChatAgentClient; catalog?: CanonicalProviderCatalog | null;
  catalogLoading?: boolean; disabled?: boolean; refreshKey?: number; onChanged?: () => void; zIndex?: number;
}) {
  const [snapshot, setSnapshot] = useState<{ client: ChatAgentClient; agentId: string; agent: ChatAgent } | null>(null);
  const [failure, setFailure] = useState<{ client: ChatAgentClient; agentId: string; message: string } | null>(null);
  const [pending, setPending] = useState(false), [open, setOpen] = useState(false), [attempt, setAttempt] = useState(0);
  const owner = useRef({ client, agentId, sequence: 0, revision: -1 });
  useLayoutEffect(() => {
    if (owner.current.client === client && owner.current.agentId === agentId) return;
    owner.current = { client, agentId, sequence: owner.current.sequence + 1, revision: -1 };
    setPending(false); setOpen(false);
  }, [client, agentId]);
  const agent = snapshot && snapshot.client === client && snapshot.agentId === agentId ? snapshot.agent : null;
  const error = failure && failure.client === client && failure.agentId === agentId ? failure.message : null;
  useEffect(() => {
    if (!client) return;
    let current = true;
    void client.list().then(result => {
      if (!current) return;
      const saved = result.enabled ? result.agents.find(candidate => candidate.id === agentId) : undefined;
      if (!saved) { setSnapshot(null); setFailure({ client, agentId, message: "Bot settings could not be loaded. Try again." }); return; }
      if (saved.revision < owner.current.revision) return;
      owner.current.revision = saved.revision;
      setSnapshot({ client, agentId, agent: saved }); setFailure(null);
    }).catch((caught: unknown) => {
      console.warn("[bots] Composer settings unavailable:", caught instanceof Error ? caught.name : "UnknownError");
      if (current) setFailure({ client, agentId, message: "Bot settings could not be loaded. Try again." });
    });
    return () => { current = false; };
  }, [client, agentId, refreshKey, attempt]);
  useEffect(() => { if (!client) return; const timer = setInterval(() => setAttempt(value => value + 1), 15_000); return () => clearInterval(timer); }, [client, agentId]);
  useEffect(() => () => { owner.current.sequence += 1; }, []);
  const changeModel = async (selection: CanonicalChatModelSelection) => {
    if (!client || !agent || agent.archived || pending || disabled || catalogLoading || !catalog) return;
    const identity = owner.current;
    const sequence = ++identity.sequence;
    setPending(true); setFailure(null);
    try {
      const updated = await client.update(agentId, { selection, baseRevision: agent.revision });
      if (owner.current !== identity || sequence !== identity.sequence) return;
      identity.revision = updated.revision;
      setSnapshot({ client, agentId, agent: updated }); setOpen(false); onChanged?.();
    } catch (caught: unknown) {
      console.warn("[bots] Composer model change unavailable:", caught instanceof Error ? caught.name : "UnknownError");
      if (owner.current === identity && sequence === identity.sequence) setFailure({ client, agentId, message: "Could not change the bot model. Refresh and try again." });
    } finally { if (owner.current === identity && sequence === identity.sequence) setPending(false); }
  };
  // Automatic's concrete funding/provider is not projected by this endpoint. Never guess it.
  const routing = agent ? isAutomaticBotSelection(agent.selection)
    ? "Automatic" : botModelRoutingLabel(agent.selection, catalog) : error ? "Bot settings unavailable" : "Checking bot model…";
  return <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button type="button" aria-label="Choose bot agent and model" aria-busy={!agent && !error || pending || catalogLoading}
      disabled={disabled || pending} title={`${agent?.name ?? "Your bot"} · ${routing}`} data-slot="bot-composer-model-trigger"
      className="no-drag flex h-8 min-w-0 max-w-[24rem] items-center gap-1.5 rounded-lg px-2 text-xs outline-none hover:bg-[var(--bg-hover,var(--muted))] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" style={chatAgentMutedStyle}>
      <span className="matrix-bot-composer-avatar size-5 shrink-0"><AgentAvatar id={agentId} name={agent?.name ?? "Your bot"}/></span>
      <span className="truncate">{agent?.name ?? "Your bot"} · {routing}</span><span aria-hidden>⌄</span>
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content side="top" align="end" sideOffset={8} collisionPadding={16} role="dialog" aria-label="Bot agent and model"
      className="matrix-chat-model-choices z-50 w-80 max-w-[calc(100vw-32px)] rounded-xl border p-4 shadow-xl" style={{ zIndex, borderColor: "var(--border-default,var(--border))", background: "var(--bg-overlay,var(--background))", color: "var(--text-primary,var(--foreground))" }}>
      <p className="mb-3 text-sm font-medium">{agent?.name ?? "Your bot"}</p>
      {agent ? <MatrixBotModelField id={`bot-composer-model-${agentId}`} label="Bot model" selection={agent.selection} models={catalog ? deriveCanonicalProviderChoices(catalog) : []}
        catalog={catalog} catalogLoading={catalogLoading} onSetup={onSetup ? () => { setOpen(false); onSetup(); } : undefined} onRefreshCatalog={onRefreshCatalog} pending={pending || !catalog || Boolean(agent.archived)} onChange={selection => { void changeModel(selection); }}/>
        : !error ? <p role="status" className="text-xs">Loading bot settings…</p> : null}
      <p className="mt-3 text-xs" style={chatAgentMutedStyle}>This conversation uses {agent?.name ?? "its bound bot"}. Automatic routing is managed by this computer.</p>
      {error ? <div className="mt-3 text-xs"><p role="alert">{error}</p><button type="button" className="mt-2 underline" onClick={() => setAttempt(value => value + 1)}>Refresh bot settings</button></div> : null}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
