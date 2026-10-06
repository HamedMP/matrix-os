import type {BotProviderConnections} from "./provider-connections-client.js";
import { MATRIX_CHATGPT_PLAN_INSTANCE_ID, MATRIX_PI_CHAT_INSTANCE_ID } from "@matrix-os/contracts";
import {chatAgentInputClass, chatAgentMutedStyle} from "../theme.js";

export function BotConnectionSelector({connections, pending, onSetup, value, showSubscription, subscriptionAvailable, onChange}: {
  connections: BotProviderConnections | null; pending: boolean; onSetup?: () => void;
  value: string; showSubscription: boolean; subscriptionAvailable: boolean; onChange(value: string): void;
}) {
 const plan = connections?.connections.find(item => item.id === MATRIX_CHATGPT_PLAN_INSTANCE_ID);
 return <div className="grid gap-1.5">
   <label className="grid gap-1.5 text-sm">Connection<select className={chatAgentInputClass} value={value} disabled={pending} onChange={event => onChange(event.target.value)}>
     <option value={MATRIX_PI_CHAT_INSTANCE_ID}>Matrix AI</option>
     {value === "computer" ? <option value="computer">Automatic · computer configuration</option> : null}
     {!["computer", MATRIX_PI_CHAT_INSTANCE_ID, MATRIX_CHATGPT_PLAN_INSTANCE_ID].includes(value) ? <option value={value} disabled>Saved connection · {value}</option> : null}
     {showSubscription ? <option value={MATRIX_CHATGPT_PLAN_INSTANCE_ID}>ChatGPT subscription · this device{subscriptionAvailable ? "" : " · unavailable"}</option> : null}
   </select></label>
   {value === MATRIX_CHATGPT_PLAN_INSTANCE_ID && !subscriptionAvailable ? <p className="text-xs" style={chatAgentMutedStyle}>{plan?.unavailableReason === "authorization_required" ? "Allow interactive Bot use in Agents & providers." : "Connect ChatGPT on your personal Electron device and allow interactive Bot use."} This device must stay connected to this Computer.</p> : null}
   <p className="text-xs" style={chatAgentMutedStyle}>This connection funds the bot’s coordinator. Choosing a task executor does not change it.</p>
   {onSetup ? <button type="button" className="justify-self-start text-xs underline" disabled={pending} onClick={onSetup}>Connect in Agents & providers</button> : null}
 </div>;
}
