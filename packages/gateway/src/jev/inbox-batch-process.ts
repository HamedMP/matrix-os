import { randomUUID } from "node:crypto";
import { createJevInboxBroker } from "./inbox-broker.js";
import type { HermesJevScope } from "../chat/hermes-integration-capability.js";
/** Each server-discovered thread uses the existing evidence/labeling pipeline with a fresh private receipt. */
export function createInboxBatchProcessor(options: Pick<Parameters<typeof createJevInboxBroker>[0], "read" | "evaluate" | "label" | "now">) {
  return async (threadId: string, signal: AbortSignal, authorize: () => Promise<void>, owner: string, scope: HermesJevScope) => {
    const privateScope = { ...scope, runId: "batch_thread_" + randomUUID() };
    const worker = createJevInboxBroker({ ...options, authorize: async () => authorize(),
      read: async (_owner, _scope, action, params, signal) => action === "list_threads" ? { threads: [{ id: threadId }] } : options.read(owner, scope, action, params, signal),
      label: options.label ? (_owner, _scope, input, signal, check) => options.label!(owner, scope, input, signal, check) : undefined });
    try {
      const discovery = await worker.execute(owner, privateScope, { operation: "discover" }, signal);
      if (discovery.kind !== "discovery")
        throw new Error("Batch discovery unavailable");
      const evidence = await worker.execute(owner, privateScope, { operation: "select", receipt: discovery.receipt, threadId }, signal);
      if (evidence.kind !== "evidence")
        return evidence;
      return await worker.execute(owner, privateScope, { operation: "evaluate", receipt: evidence.receipt }, signal);
    }
    finally {
      worker.clearRun(owner, privateScope.runId);
    }
  };
}
