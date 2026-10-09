import {useEffect, useState} from "react";
import type {BotConnectionClient, BotProviderConnections} from "./provider-connections-client.js";

/** Cache is transport-scoped; a stale display snapshot never grants execution. */
export function useBotConnections(client?: Pick<BotConnectionClient, "connections" | "refreshConnections">, refreshKey?: unknown) {
 const [snapshot, setSnapshot] = useState<{client: typeof client; value: BotProviderConnections} | null>(null);
 const [error, setError] = useState<{client: typeof client; value: string} | null>(null);
 const [attempt, setAttempt] = useState(0);
 useEffect(() => {
   if (!client) return;
   if(refreshKey!==undefined) client.refreshConnections?.();
   const scope = new AbortController();
   void client.connections(scope.signal).then(value => {
     if (!scope.signal.aborted) {setSnapshot({client, value}); setError(null);}
   }).catch(caught => {
     if (scope.signal.aborted) return;
     console.warn("[bot-connections] Discovery unavailable:", caught instanceof Error ? caught.name : typeof caught);
     setError({client, value: "Bot connections are unavailable. Check again."});
   });
   const refresh=()=>{client.refreshConnections?.(); setAttempt(value=>value+1);};
   window.addEventListener("focus",refresh);
   return () => {scope.abort(); window.removeEventListener("focus",refresh);};
 }, [client, attempt, refreshKey]);
 return {connections: snapshot && snapshot.client === client && error?.client !== client ? snapshot.value : null,
   error: error && error.client === client ? error.value : null,
   loading: !!client && snapshot?.client !== client && error?.client !== client,
   refresh: () => {client?.refreshConnections?.(); setSnapshot(null); setError(null); setAttempt(value => value + 1);}};
}
