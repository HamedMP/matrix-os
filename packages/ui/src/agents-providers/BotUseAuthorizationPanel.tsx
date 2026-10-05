import {useEffect, useRef, useState} from "react";
import type {BotConnectionClient} from "../chat-agents/bots/provider-connections-client.js";
import {useBotConnections} from "../chat-agents/bots/use-bot-connections.js";

/** Revokes Matrix Bot use without signing out native coding-agent consumers. */
export function BotUseAuthorizationPanel({client, harness, disabled, refreshKey}: {client: BotConnectionClient; harness: "codex" | "claude"; disabled: boolean; refreshKey?:string}) {
 const state = useBotConnections(client,refreshKey);
 const connection = state.connections?.connections.find(item => item.id === (harness === "codex" ? "matrix_chatgpt_plan" : "claude_code_tasks"));
 const mayEnable = connection?.availability === "available" || connection?.unavailableReason === "authorization_required";
 const [background, setBackground] = useState(false), [pending, setPending] = useState(false), [failure, setFailure] = useState<string | null>(null);
 const owner = useRef({client, harness, mounted:true, controller:new AbortController()});
 if (owner.current.client !== client || owner.current.harness !== harness) owner.current = {client,harness,mounted:true,controller:new AbortController()};
 useEffect(() => {const scope=owner.current; scope.mounted=true; if(scope.controller.signal.aborted) scope.controller=new AbortController(); return () => {scope.mounted=false; scope.controller.abort();};}, [client,harness]);
 useEffect(() => {setBackground(connection?.authorization.background ?? false);}, [client, connection?.authorization.revision]);
 useEffect(() => {setFailure(null); setPending(false);}, [client,harness]);
 const update = async (enabled: boolean) => {
   if (!connection || disabled || pending || (enabled && !mayEnable)) return;
   const scope = owner.current;
   setPending(true); setFailure(null);
   try {
     await client.authorizeConnection(connection.id, {baseRevision: connection.authorization.revision, enabled, background: enabled && background}, scope.controller.signal);
     if (owner.current === scope && scope.mounted) state.refresh();
   } catch (caught) {
     console.warn("[bot-connections] Authorization unavailable:", caught instanceof Error ? caught.name : typeof caught);
     if (owner.current === scope && scope.mounted) {setFailure("Bot authorization could not be updated. Check again."); state.refresh();}
   } finally {if (owner.current === scope && scope.mounted) setPending(false);}
 };
 return <section className="matrix-ap-workflow" aria-label={harness === "codex" ? "ChatGPT Bot authorization" : "Claude Code Bot authorization"}>
   <h3>{harness === "codex" ? "Use in Bots" : "Use for Bot tasks"}</h3>
   <p className="matrix-ap-help">{harness === "codex" ? "Matrix needs its own ChatGPT authorization before a bot can use your plan." : "Bot tasks use the Claude Code account connected on this computer. This does not sign in again."}</p>
   <p className="matrix-ap-help">The bot’s coordinator has a separate model connection and funding source.</p>
   {state.loading ? <p role="status">Loading Bot authorization…</p> : null}
   {state.error ? <p role="alert">{state.error}</p> : null}
   {connection?.availability === "unavailable" ? <p role="status" className="matrix-ap-help">{connection.unavailableReason === "provider_access_required" ? "ChatGPT plan access for Matrix Bots requires provider approval for this deployment." : "Bot execution is unavailable on this computer."}</p> : null}
   {connection?.availability === "setup_required" && !mayEnable ? <p role="status" className="matrix-ap-help">Connect the native account on this computer before enabling Bot use.</p> : null}
   {connection && mayEnable ? <>
     <p role="status">{connection.authorization.enabled ? "Available in Bots" : "Not enabled for Bots"}</p>
     <label className="matrix-ap-uninstall-choice"><input type="checkbox" checked={background} disabled={disabled || pending} onChange={event => setBackground(event.target.checked)}/>Allow scheduled and background Bot tasks<span>Uses your subscription when a bot runs without a message from you.</span></label>
     <div className="matrix-ap-workflow-actions">
       <button type="button" className="matrix-ap-button" disabled={disabled || pending} onClick={() => void update(true)}>{pending ? "Updating…" : connection.authorization.enabled ? "Save Bot permissions" : harness === "codex" ? "Enable for Bots" : "Enable for Bot tasks"}</button>
       {connection.authorization.enabled ? <button type="button" className="matrix-ap-link-button" disabled={disabled || pending} onClick={() => void update(false)}>Disconnect from Bots</button> : null}
     </div>
   </> : null}
   {connection?.authorization.enabled && !mayEnable ? <button type="button" className="matrix-ap-link-button" disabled={disabled || pending} onClick={() => void update(false)}>Disconnect from Bots</button> : null}
   {failure ? <p role="alert" className="matrix-ap-help">{failure}</p> : null}
   {state.error || failure ? <button type="button" className="matrix-ap-button" disabled={pending} onClick={state.refresh}>Check again</button> : null}
 </section>;
}
