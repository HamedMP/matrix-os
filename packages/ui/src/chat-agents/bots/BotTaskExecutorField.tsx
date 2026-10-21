import {useEffect, useState} from "react";
import type {BotProviderConnections} from "./provider-connections-client.js";
import {chatAgentInputClass, chatAgentMutedStyle} from "../theme.js";
export type BotExecutorSelection = {connectionId: "claude_code_tasks"; model: string};

/** Claude Code executes tasks separately from the Pi coordinator's model loop. */
export function BotTaskExecutorField({connections, value, pending, onChange, onSetup, onRefresh, onIncompleteChange}: {
 connections: BotProviderConnections | null; value: BotExecutorSelection | null; pending: boolean;
 onRefresh?:()=>void; onIncompleteChange?: (value:boolean) => void; onChange(value: BotExecutorSelection | null): void; onSetup?: () => void;
}) {
 const connection = connections?.connections.find(item => item.id === "claude_code_tasks");
 const [chosen, setChosen] = useState(value?.connectionId ?? "");
 useEffect(() => setChosen(value?.connectionId ?? ""), [value?.connectionId]);
 const available = connection?.availability === "available" && connection.authorization.enabled && connection.models.length > 0;
 const savedUnavailable = value && (!available || !connection?.models.some(model => model.id === value.model));
 return <section className="grid gap-2">
   <label className="grid gap-1.5 text-sm">Task executor<select className={chatAgentInputClass} value={chosen} disabled={pending || !connections} onChange={event => {
     setChosen(event.target.value); onIncompleteChange?.(!!event.target.value && !value); if (!event.target.value) onChange(null);
   }}><option value="">Bot tools only</option><option value="claude_code_tasks" disabled={!available}>Claude Code{available ? "" : " · unavailable"}</option></select></label>
   {chosen === "claude_code_tasks" ? <label className="grid gap-1.5 text-sm">Task model<select className={chatAgentInputClass} value={value?.model ?? ""} disabled={pending || !available} onChange={event => {
     if (available && connection?.models.some(model => model.id === event.target.value)) {onIncompleteChange?.(false); onChange({connectionId:"claude_code_tasks", model:event.target.value});}
   }}><option value="" disabled>Choose a task model</option>{savedUnavailable ? <option value={value.model} disabled>{value.model} · unavailable</option> : null}{connection?.models.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label> : null}
   <p className="text-xs" style={chatAgentMutedStyle}>Claude Code tasks use its native account on this computer. The bot’s coordinator still uses its selected connection and funding source.</p>
   {!available ? <p role="status" className="text-xs" style={chatAgentMutedStyle}>{connection?.availability === "setup_required" ? "Connect Claude Code on this computer first." : connection?.authorization.enabled === false ? "Enable Claude Code for Bot tasks in Agents & providers." : "Claude Code task execution is unavailable on this computer."} {onSetup ? <button type="button" className="underline" disabled={pending} onClick={onSetup}>Agents & providers</button> : null}</p> : null}
   {!available && onRefresh ? <button type="button" className="justify-self-start text-xs underline" disabled={pending} onClick={onRefresh}>Check task connections</button> : null}
   {savedUnavailable ? <p role="status" className="text-xs" style={chatAgentMutedStyle}>This saved task executor is unavailable. It will not fall back to another account.</p> : null}
 </section>;
}
