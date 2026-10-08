import type {BotClient} from "./client.js";
import type {BotExecutorSelection} from "./BotTaskExecutorField.js";

/** Caller retains chatId before this step; retry never instantiates another Bot. */
export async function configureCreatedExecutor(client: BotClient, chatId: string, selection: BotExecutorSelection | null, isCurrent:()=>boolean = ()=>true, clearExisting = false) {
 if (!selection && !clearExisting) return;
 if (!isCurrent()) throw new Error("Task execution is unavailable.");
 if (!client.execution || !client.configureExecution) throw new Error("Task execution is unavailable.");
 const agentId = await client.directBot(chatId);
 if (!isCurrent() || !agentId) throw new Error("Task execution is unavailable.");
 const current = await client.execution(agentId);
 if (!isCurrent()) throw new Error("Task execution is unavailable.");
 if (!selection && current.connectionId === null) return;
 await client.configureExecution(agentId,{baseRevision:current.revision,connectionId:selection?.connectionId ?? null,...(selection ? {model:selection.model} : {})});
}
