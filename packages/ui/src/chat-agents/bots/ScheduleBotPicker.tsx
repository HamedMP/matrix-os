import {useEffect, useRef, useState} from "react";
import type {ChatAgent} from "@matrix-os/contracts";
import type {ChatAgentClient} from "../client.js";
import {isSchedulingBot} from "./routine-presentation.js";
import {AgentAvatar} from "../AgentAvatar.js";
import {chatAgentButtonClass, chatAgentMutedStyle} from "../theme.js";

/** Choosing a Bot opens its canonical private Chat; it never edits the Bot or sends a prompt. */
export function ScheduleBotPicker({client, onOpen, onDone, onBack, onManage}: {
  client: ChatAgentClient; onOpen?: (chatId: string) => void | Promise<void>; onDone(): void;
  onBack(trigger: HTMLButtonElement): void; onManage(): void;
}) {
  const [agents, setAgents] = useState<ChatAgent[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [pending, setPending] = useState(false), [retry, setRetry] = useState(0);
  const lifetime = useRef(0), busy = useRef(false);
  useEffect(() => {
    const generation = ++lifetime.current;
    setAgents([]); setLoading(true); setError("");
    void client.list().then(value => {
      if (generation !== lifetime.current) return;
      if (!value.enabled) throw new Error("Bots unavailable");
      setAgents(value.agents.filter(isSchedulingBot).slice(0, 100));
    }).catch((failure: unknown) => {
      console.warn("[schedule-picker] Bots unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === lifetime.current) setError("Bots could not be loaded. Try again.");
    }).finally(() => {if (generation === lifetime.current) setLoading(false);});
    return () => {++lifetime.current;};
  }, [client, retry]);
  async function choose(agentId: string) {
    if (busy.current || !client.bots || !onOpen) return;
    const generation = lifetime.current;
    busy.current = true; setPending(true); setError("");
    try {
      const chatId = await client.bots.ensureDirectChat(agentId);
      if (generation !== lifetime.current) return;
      if (!chatId) throw new Error("Chat unavailable");
      await onOpen(chatId);
      if (generation === lifetime.current) onDone();
    } catch (failure: unknown) {
      console.warn("[schedule-picker] Chat unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === lifetime.current) setError("This Bot’s Chat could not be opened. Try again.");
    } finally {busy.current = false; if (generation === lifetime.current) setPending(false);}
  }
  return <section aria-label="New schedule" className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto p-4 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-lg font-semibold">New schedule</h1><button type="button" className={chatAgentButtonClass} onClick={event => onBack(event.currentTarget)}>Back to schedules</button></header>
    <p className="text-sm" style={chatAgentMutedStyle}>Choose a private Bot, then describe your task and timing in Chat. Review its proposal before any scheduled run.</p>
    {loading ? <p role="status">Loading Bots…</p> : null}
    {error ? <div role="alert"><p>{error}</p><button type="button" className={chatAgentButtonClass} disabled={pending} onClick={() => setRetry(value => value + 1)}>Try again</button></div> : null}
    {!loading && !error && !agents.length ? <p>No scheduling Bots yet. Create a Bot from a template in Agents, then describe its schedule in Chat.</p> : null}
    <ul className="grid min-w-0 gap-2">{agents.map(agent => <li key={agent.id}><button type="button" aria-label={`Schedule with ${agent.name}`} disabled={pending || !onOpen || !client.bots} className={`${chatAgentButtonClass} flex w-full min-w-0 items-center gap-3 text-left`} onClick={() => void choose(agent.id)}>
      <AgentAvatar id={agent.id} name={agent.name} size="small"/><span className="min-w-0"><span className="block break-words font-medium">{agent.name}</span><span className="block text-xs" style={chatAgentMutedStyle}>Open private Chat</span></span>
    </button></li>)}</ul>
    <div><button type="button" className={chatAgentButtonClass} disabled={pending} onClick={onManage}>Create or manage Bots</button></div>
  </section>;
}
