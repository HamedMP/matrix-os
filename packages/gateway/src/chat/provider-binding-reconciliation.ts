import { CanonicalChatModelSelectionSchema } from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import { jsonb, parseJson } from "./records.js";

const RECONCILIATION_LIMIT = 100;

export interface ProviderBindingReconciliationResult {
  repaired: number;
  unresolved: number;
}

/**
 * Restores only the mutable selection projection. The immutable binding is
 * evidence, never a repair target: its referenced Turn must contain a Run
 * whose Driver and Provider Instance exactly prove the stored binding.
 */
export async function reconcileProviderBindings(
  db: Kysely<ChatDatabase>,
): Promise<ProviderBindingReconciliationResult> {
  const result = await db.transaction().execute(async (trx) => reconcileInTransaction(trx));
  for (const diagnostic of result.diagnostics) {
    console.warn("[chat/provider-binding] reconciliation unavailable", diagnostic);
  }
  return { repaired: result.repaired, unresolved: result.diagnostics.length };
}

async function reconcileInTransaction(
  trx: Transaction<ChatDatabase>,
): Promise<ProviderBindingReconciliationResult & {
  diagnostics: Array<{ chatId: string; reason: "provenance_unavailable" }>;
}> {
  const candidates = await trx.selectFrom("chats")
    .select([
      "id",
      "bound_driver_kind",
      "bound_instance_id",
      "bound_at_turn_id",
      "current_selection",
    ])
    .where("bound_driver_kind", "is not", null)
    .where("bound_instance_id", "is not", null)
    .where("bound_at_turn_id", "is not", null)
    .where(sql<boolean>`(
      current_selection IS NULL
      OR current_selection->>'instanceId' IS DISTINCT FROM bound_instance_id
    )`)
    .orderBy("id")
    .limit(RECONCILIATION_LIMIT)
    .forUpdate()
    .execute();
  let repaired = 0;
  const diagnostics: Array<{ chatId: string; reason: "provenance_unavailable" }> = [];
  for (const chat of candidates) {
    const run = await trx.selectFrom("chat_runs")
      .select(["selection", "driver_kind", "instance_id"])
      .where("chat_id", "=", chat.id)
      .where("turn_id", "=", chat.bound_at_turn_id!)
      .where("driver_kind", "=", chat.bound_driver_kind!)
      .where("instance_id", "=", chat.bound_instance_id!)
      .orderBy("attempt", "asc")
      .executeTakeFirst();
    const selection = provenSelection(run?.selection, chat.bound_instance_id!);
    if (!run || !selection) {
      diagnostics.push({ chatId: chat.id, reason: "provenance_unavailable" });
      continue;
    }
    const updated = await trx.updateTable("chats").set({
      current_selection: jsonb(selection),
      revision: sql<number>`revision + 1`,
      updated_at: sql`now()`,
    }).where("id", "=", chat.id)
      .where("bound_driver_kind", "=", chat.bound_driver_kind!)
      .where("bound_instance_id", "=", chat.bound_instance_id!)
      .where("bound_at_turn_id", "=", chat.bound_at_turn_id!)
      .where(sql<boolean>`(
        current_selection IS NULL
        OR current_selection->>'instanceId' IS DISTINCT FROM bound_instance_id
      )`)
      .returning("id")
      .executeTakeFirst();
    if (updated) repaired += 1;
  }
  return { repaired, unresolved: diagnostics.length, diagnostics };
}

function provenSelection(value: unknown, boundInstanceId: string) {
  if (value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = parseJson(value);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
  const selection = CanonicalChatModelSelectionSchema.safeParse(parsed);
  return selection.success && selection.data.instanceId === boundInstanceId
    ? selection.data
    : null;
}
