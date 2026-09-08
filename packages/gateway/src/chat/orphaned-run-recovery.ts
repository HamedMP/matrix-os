import { z } from "zod/v4";
import type { CanonicalChatRun } from "@matrix-os/contracts";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import { boundedOperation } from "../bounded-operation.js";
import { ChatConflictError } from "./errors.js";

const Snapshot = z.object({
  outcome: z.enum(["completed", "failed", "aborted"]),
  messages: z.array(z.object({ messageId: z.string().min(1).max(512).optional(), text: z.string().max(96 * 1024) })).max(256),
}).refine((value) => value.messages.reduce((size, message) => size + Buffer.byteLength(message.text), 0) <= 96 * 1024);

export async function recoverOrphanedRun(input: {
  owner: ChatOwner;
  run: CanonicalChatRun;
  repository: Pick<ChatRepository, "getAdapterState" | "appendAssistantDelta" | "finishRun">;
  adapter: CanonicalChatProviderAdapter | undefined;
  messageId: (runId: string, providerId?: string) => string;
  completedAt: string;
}): Promise<boolean> {
  const { owner, run, repository, adapter, completedAt } = input;
  if (!adapter) return false;
  const stored = await repository.getAdapterState(owner, {
    runId: run.id, driverKind: run.driverKind, instanceId: run.instanceId,
  });
  if (!stored || stored.schemaVersion !== adapter.stateSchemaVersion) return false;
  const state = adapter.parseState(stored.state);
  let recovered: z.infer<typeof Snapshot> | null = null;
  try {
    if (adapter.recover) {
      const snapshot = await boundedOperation((signal) => adapter.recover!({ owner, runId: run.id, state, signal }), 10_000);
      if (snapshot) recovered = Snapshot.parse(snapshot);
    }
  } catch (error: unknown) {
    console.warn("[chat/recovery] Backing snapshot unavailable", { runId: run.id, errorType: error instanceof Error ? error.name : "UnknownError" });
  }
  if (!recovered) {
    try {
      await boundedOperation(async () => {
        await adapter.cancel?.({ owner, chatId: run.chatId, runId: run.id, state });
      }, 5_000);
    } catch (error: unknown) {
      console.warn("[chat/recovery] Cancellation unconfirmed", { runId: run.id, remoteOutcome: "unknown", errorType: error instanceof Error ? error.name : "UnknownError" });
    }
    return false;
  }
  for (const message of recovered.messages) {
    if (!message.text) continue;
    // Prefix merge is checked under the durable Run lock, so another restart
    // after a partial repair cannot append the same output twice.
    try {
      await repository.appendAssistantDelta(owner, {
        chatId: run.chatId, runId: run.id,
        messageId: input.messageId(run.id, message.messageId),
        delta: message.text, snapshot: true, createdAt: completedAt,
      });
    } catch (error: unknown) {
      if (!(error instanceof ChatConflictError)) throw error;
      // Preserve committed text and let reconciliation mark the Run failed;
      // an incompatible backing snapshot must not leave it Working forever.
      console.warn("[chat/recovery] Backing snapshot conflicts with committed output", { runId: run.id });
      return false;
    }
  }
  const result = await repository.finishRun(owner, {
    chatId: run.chatId, runId: run.id, outcome: recovered.outcome, completedAt,
  });
  return result.transitioned;
}
