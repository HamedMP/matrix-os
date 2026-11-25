import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { chatSendTimingsEnabled } from "../chat/send-timing.js";

type DeliveryStage = "bridge_read" | "bridge_ingest" | "store_queue_wait" | "store_read"
  | "store_mutation" | "store_write" | "store_projection";
const delivery = new AsyncLocalStorage<string>();

export function withCodexDeliveryTiming<T>(sessionId: string, operation: () => T): T {
  if (!chatSendTimingsEnabled()) return operation();
  // Match the runner_link session hash. Never log native IDs or transcript data.
  return delivery.run(createHash("sha256").update(sessionId).digest("hex").slice(0, 20), operation);
}

export function recordCodexDeliveryStage(stage: DeliveryStage, startedAt: number): void {
  const session = delivery.getStore();
  if (!session) return;
  console.info("[chat-send-timing]", JSON.stringify({ session, stage,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)) }));
}

export async function measureCodexDeliveryStage<T>(stage: DeliveryStage, operation: () => Promise<T>): Promise<T> {
  if (!delivery.getStore()) return operation();
  const startedAt = performance.now();
  try { return await operation(); }
  finally { recordCodexDeliveryStage(stage, startedAt); }
}
