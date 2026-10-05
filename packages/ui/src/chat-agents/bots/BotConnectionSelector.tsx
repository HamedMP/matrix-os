import type {BotProviderConnections} from "./provider-connections-client.js";
import {chatAgentInputClass, chatAgentMutedStyle} from "../theme.js";

export function BotConnectionSelector({connections, pending, onSetup, automatic = false}: {connections: BotProviderConnections | null; pending: boolean; automatic?: boolean; onSetup?: () => void}) {
 const chatgpt = connections?.connections.find(item => item.id === "matrix_chatgpt_plan");
 return <div className="grid gap-1.5">
   <label className="grid gap-1.5 text-sm">Connection<select className={chatAgentInputClass} value={automatic ? "computer" : "matrix_ai"} disabled>
     {automatic ? <option value="computer">Automatic · computer configuration</option> : <option value="matrix_ai">Matrix AI</option>}
     {chatgpt ? <option value={chatgpt.id} disabled>ChatGPT subscription · unavailable</option> : null}
   </select></label>
   {chatgpt?.unavailableReason === "provider_access_required" ? <p className="text-xs" style={chatAgentMutedStyle}>ChatGPT plan access for Matrix Bots requires provider approval for this deployment. Native Codex login stays separate.</p> : null}
   <p className="text-xs" style={chatAgentMutedStyle}>This connection funds the bot’s coordinator. Choosing a task executor does not change it.</p>
   {onSetup ? <button type="button" className="justify-self-start text-xs underline" disabled={pending} onClick={onSetup}>Connect in Agents & providers</button> : null}
 </div>;
}
