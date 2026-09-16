import type { CanonicalChatProviderRegistry } from "./provider-adapter.js";
import type { ChatRepository } from "./repository.js";
import type { ChatOwner } from "./records.js";

/** A shutdown detaches observation; it is not a user cancellation. */
export class BackgroundProjectionDetached extends Error {
  constructor() { super("Background projection detached"); this.name = "BackgroundProjectionDetached"; }
}

export async function recoverBackgroundRunControl(input: {
  owner: ChatOwner; chatId: string; runId: string;
  repository: Pick<ChatRepository, "listActiveRunContexts" | "getAdapterState">;
  adapters: CanonicalChatProviderRegistry;
}) {
  const context = (await input.repository.listActiveRunContexts(input.owner, 64))
    .find(item => item.latestRun.id === input.runId && item.latestRun.chatId === input.chatId);
  if (!context) return undefined;
  const run = context.latestRun;
  const adapter = input.adapters.get(run.driverKind);
  if (!adapter?.detachOnShutdown) return undefined;
  const stored = await input.repository.getAdapterState(input.owner, {
    runId: run.id, driverKind: run.driverKind, instanceId: run.instanceId,
  });
  if (!stored || stored.schemaVersion !== adapter.stateSchemaVersion) throw new Error("Background control identity unavailable");
  adapter.parseState(stored.state);
  return { adapter, owner: input.owner, chatId: input.chatId, runId: input.runId, instanceId: run.instanceId, controller: new AbortController() };
}
