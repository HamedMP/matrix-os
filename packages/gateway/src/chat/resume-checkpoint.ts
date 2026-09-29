import type { Kysely } from "kysely";
import type { CanonicalChatRunPolicy } from "@matrix-os/contracts";
import type { ChatDatabase } from "./database.js";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";

const MAX_UNHEARD_DELIVERIES = 200;

/**
 * Delivery-aware checkpoint eligibility: run/message ids behind a delivery
 * record that is not verified `complete` (pending, playing, interrupted, or
 * unknown) were never provably heard, so their checkpoints are ineligible.
 * Derived inside the authority so claim/retry paths cannot forget it.
 */
async function listUnheardDeliveryIds(
  kysely: Kysely<ChatDatabase>, owner: ChatOwner, chatId: string,
): Promise<string[]> {
  const rows = await kysely.selectFrom("chat_voice_deliveries as delivery")
    .innerJoin("chats as chat", "chat.id", "delivery.chat_id")
    .select(["delivery.run_id", "delivery.message_id"])
    .where("delivery.chat_id", "=", chatId)
    .where("chat.owner_type", "=", owner.type)
    .where("chat.owner_id", "=", owner.ownerId)
    .where("delivery.state", "<>", "complete")
    .orderBy("delivery.created_at", "desc")
    .limit(MAX_UNHEARD_DELIVERIES)
    .execute();
  return rows.flatMap((row) => [row.run_id, row.message_id]);
}

/**
 * Shared policy for immediate follow-ups, durable queued turns, and Retry.
 * Delivery-aware: checkpoints produced by unheard/unknown deliveries are
 * ineligible, and disposable/session-only policies never reuse native state.
 * When a provider harness cannot rebuild safely, it gets no checkpoint at
 * all — Matrix-owned state remains the recovery authority.
 */
export async function loadChatResumeState(input: {
  // `kysely` stays optional so narrow test picks still compile; the full
  // ChatRepository supplies it at runtime and gets unheard-derivation.
  repository: Pick<ChatRepository, "getLatestAdapterStateForChat"> & {
    kysely?: ChatRepository["kysely"] | null;
  };
  owner: ChatOwner;
  chatId: string;
  instanceId: string;
  adapter: CanonicalChatProviderAdapter;
  executionRootFingerprint: string | null;
  mode: "follow_up" | "retry";
  /** Immutable execution policy of the run being admitted. */
  runPolicy?: CanonicalChatRunPolicy;
  /** Caller-supplied delivery awareness: ids whose output was never heard. */
  deliveryContext?: { unheardResponses?: readonly string[] };
}): Promise<unknown> {
  // A disposable checkpoint policy never resumes native provider state. The
  // session-only schema guarantees disposable, so both gates are checked.
  if (input.runPolicy?.nativeCheckpointPolicy === "disposable") return undefined;
  let derived: string[];
  if (!input.repository.kysely) {
    derived = [];
  } else {
    try {
      derived = await listUnheardDeliveryIds(input.repository.kysely, input.owner, input.chatId);
    } catch {
      // Fail closed: a failed derivation cannot prove every checkpoint source was
      // heard, so this run gets no native checkpoint at all.
      return undefined;
    }
  }
  const unheardResponses = [...new Set([
    ...derived,
    ...(input.deliveryContext?.unheardResponses ?? []),
  ]).values()];
  const previous = await input.repository.getLatestAdapterStateForChat(input.owner, {
    chatId: input.chatId,
    driverKind: input.adapter.driverKind,
    instanceId: input.instanceId,
    schemaVersion: input.adapter.stateSchemaVersion,
    executionRootFingerprint: input.executionRootFingerprint,
    includeInterrupted: input.mode === "follow_up",
    sessionOnly: input.runPolicy?.memoryMode === "session_only",
    ...(unheardResponses.length > 0 ? { unheardResponses } : {}),
  });
  // Compatibility is filtered in SQL before choosing the newest checkpoint.
  // An incompatible interruption must not hide an older compatible session.
  return previous ? input.adapter.parseState(previous.state) : undefined;
}
