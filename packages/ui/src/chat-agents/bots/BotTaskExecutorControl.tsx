import {useEffect, useRef, useState} from "react";
import type {BotClient} from "./client.js";
import type {BotExecutionBinding} from "./provider-connections-client.js";
import {BotTaskExecutorField, type BotExecutorSelection} from "./BotTaskExecutorField.js";
import {useBotConnections} from "./use-bot-connections.js";

export function BotTaskExecutorControl({client, agentId, pending, onSetup}: {client: BotClient; agentId: string; pending: boolean; onSetup?: () => void}) {
 const owner = useRef<{client:BotClient; agentId:string; mounted:boolean; pending:boolean}>({client,agentId,mounted:true,pending:false});
 if (owner.current.client !== client || owner.current.agentId !== agentId) owner.current = {client,agentId,mounted:true,pending:false};
 useEffect(() => {const scope=owner.current; scope.mounted=true; return () => {scope.mounted=false;};},[client,agentId]);
 const discovery = useBotConnections(client.connections ? client as Required<Pick<BotClient,"connections">> : undefined);
 const [snapshot, setSnapshot] = useState<{client: BotClient; agentId:string; binding:BotExecutionBinding} | null>(null);
 const [working, setWorking] = useState(false), [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
 useEffect(() => {
   const scope = new AbortController(); setWorking(false); setError(null);
   if (client.execution) void client.execution(agentId, scope.signal).then(binding => {
     if (!scope.signal.aborted) setSnapshot({client,agentId,binding});
   }).catch(caught => {
     console.warn("[bot-connections] Binding unavailable:", caught instanceof Error ? caught.name : typeof caught);
     if (!scope.signal.aborted) setError("Task executor could not be loaded. Check again.");
   });
   return () => scope.abort();
 }, [client,agentId,attempt]);
 const binding = snapshot?.client === client && snapshot.agentId === agentId ? snapshot.binding : null;
 const needsConsent = !!binding?.connectionId && !!discovery.connections?.connections.some(connection => connection.id === binding.connectionId && connection.authorization.revision !== binding.grantRevision);
 const canAuthorizeSaved = !!binding?.model && !!discovery.connections?.connections.some(connection => connection.id === binding.connectionId && connection.availability === "available" && connection.authorization.enabled && connection.models.some(model => model.id === binding.model));
 const change = async (selection:BotExecutorSelection | null) => {
   if (!binding || !client.configureExecution || pending || working || owner.current.pending) return;
   const scope = owner.current; scope.pending=true;
   setWorking(true); setError(null);
   try {
     const updated = await client.configureExecution(agentId,{baseRevision:binding.revision, connectionId:selection?.connectionId ?? null, ...(selection ? {model:selection.model}: {})});
     if (owner.current !== scope || !scope.mounted) return;
     setSnapshot(current => current?.client === client && current.agentId === agentId ? {...current,binding:updated} : current);
   } catch (caught) {
     console.warn("[bot-connections] Binding update unavailable:", caught instanceof Error ? caught.name : typeof caught);
     if (owner.current === scope && scope.mounted) setError("Task executor could not be updated. Check again.");
   } finally {scope.pending=false; if (owner.current === scope && scope.mounted) setWorking(false);}
 };
 if (!client.connections || !client.execution) return null;
 return <>
   <BotTaskExecutorField connections={discovery.connections} value={binding?.connectionId && binding.model ? {connectionId:binding.connectionId,model:binding.model} : null} pending={pending || working || !binding} onChange={value => void change(value)} onSetup={onSetup} onRefresh={discovery.refresh}/>
   {needsConsent && binding?.model ? <div className="text-xs"><p role="status">Bot permissions changed. Authorize this bot again before running tasks.</p><button type="button" className="underline" disabled={pending || working || !canAuthorizeSaved} onClick={() => void change({connectionId:"claude_code_tasks",model:binding.model!})}>Authorize this bot again</button></div> : null}
   {error || discovery.error ? <div className="text-xs"><p role="alert">{error ?? discovery.error}</p><button type="button" className="underline" disabled={working} onClick={() => {discovery.refresh(); setAttempt(value=>value+1);}}>Check again</button></div> : null}
 </>;
}
