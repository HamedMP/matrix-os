/**
 * Person aliases. Derivation merges a `name:` key into the `email:` entity when exactly one email was seen with that
 * name across the scope's live documents (reason single_email_for_name), and drops that merge when it stops holding.
 * The owner merges or splits by hand (reason manual); a split ("not the same person") row stays, so derivation never
 * re-merges that key. An unmerge undoes a manual merge: its row goes, so the pair is back where it was before the
 * merge (suggested again, decided again by derivation). entity_id is always the root; via_entity_id keeps the entity a
 * carried alias was merged into, so a split or an unmerge moves the aliases that came in through that entity back to
 * it. Callers hold the brain-graph:<scope> lock.
 */
import { sql, type Transaction } from "kysely";
import { BrainApiError } from "../api/types.js";
import { BRAIN_GRAPH_LIMITS, BrainFeatureError, type BrainAliasInput } from "../contracts.js";
import type { BrainScopeKey } from "../types.js";
import { brainEntityId, parseEntityInput } from "./ids.js";
import { resolveRoot } from "./reads.js";
import type { BrainGraphDatabase, BrainGraphExecutor } from "./types.js";

type Trx = Transaction<BrainGraphDatabase>;

function aliases(db: BrainGraphExecutor, scope: BrainScopeKey) {
  return db.selectFrom("brain_graph_aliases").where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId);
}

/** The entity a merged alias resolves to, else the id itself. */
export async function rootOf(db: BrainGraphExecutor, scope: BrainScopeKey, entityId: string): Promise<string> {
  const row = await aliases(db, scope).select("entity_id").where("alias_entity_id", "=", entityId)
    .where("state", "=", "merged").executeTakeFirst();
  return row?.entity_id ?? entityId;
}

/** Distinct email keys seen with a name key in live documents of the scope; at most two (two means ambiguous). */
async function emailsSeenWith(trx: Trx, scope: BrainScopeKey, nameKey: string): Promise<string[]> {
  const result = await sql<{ email: string }>`
    SELECT DISTINCT pair->>'e' AS email FROM brain_graph_state s
    JOIN brain_documents d ON d.owner_id = s.owner_id AND d.scope_id = s.scope_id AND d.document_id = s.document_id
    CROSS JOIN LATERAL jsonb_array_elements(s.identities) AS pair
    WHERE s.owner_id = ${scope.ownerId} AND s.scope_id = ${scope.scopeId} AND d.deleted_at IS NULL
      AND s.identities @> ${JSON.stringify([{ n: nameKey }])}::jsonb AND pair->>'n' = ${nameKey}
    ORDER BY 1 LIMIT 2`.execute(trx);
  return result.rows.map((row) => row.email);
}

async function writeAlias(
  trx: Trx, scope: BrainScopeKey, aliasKey: string, entityId: string, via: string | null,
  reason: "single_email_for_name" | "manual", now: Date,
): Promise<void> {
  const at = now.toISOString();
  const update = { entity_id: entityId, via_entity_id: via, reason, state: "merged" as const, updated_at: at };
  await trx.insertInto("brain_graph_aliases").values({
    owner_id: scope.ownerId, scope_id: scope.scopeId, alias_entity_id: parseEntityInput(aliasKey)!.entityId,
    alias_key: aliasKey, created_at: at, ...update,
  }).onConflict((conflict) => conflict.columns(["owner_id", "scope_id", "alias_entity_id"]).doUpdateSet(update))
    .execute();
}

/** Merged aliases that resolve to `entityId`. */
async function mergedCount(trx: Trx, scope: BrainScopeKey, entityId: string): Promise<number> {
  const row = await aliases(trx, scope).select((eb) => eb.fn.countAll<number>().as("n"))
    .where("entity_id", "=", entityId).where("state", "=", "merged").executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Moves the merged aliases of `aliasId` to `root`, each keeping the entity it came in through (returnCarried). */
async function carryAliases(trx: Trx, scope: BrainScopeKey, aliasId: string, root: string, at: string): Promise<void> {
  await trx.updateTable("brain_graph_aliases")
    .set({ entity_id: root, via_entity_id: sql<string>`coalesce(via_entity_id, entity_id)`, updated_at: at })
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("entity_id", "=", aliasId).where("state", "=", "merged").execute();
}

/**
 * Re-decides the automatic alias of each `name:` key (manual and split rows are never touched). Like a manual merge,
 * an automatic one carries the name's own aliases along, and they go back to it when it is dropped or moves. An
 * entity holds at most aliasesPerEntity merged aliases, automatic ones and carried ones too: past that the name stays
 * its own person.
 */
export async function reconcileNameAliases(
  trx: Trx, scope: BrainScopeKey, nameKeys: readonly string[], now: Date,
): Promise<void> {
  const at = now.toISOString();
  for (const nameKey of nameKeys) {
    const aliasId = brainEntityId("person", nameKey);
    const existing = await aliases(trx, scope).select(["entity_id", "via_entity_id", "reason", "state"])
      .where("alias_entity_id", "=", aliasId).executeTakeFirst();
    if (existing !== undefined && (existing.state === "split" || existing.reason === "manual")) continue;
    const emails = await emailsSeenWith(trx, scope, nameKey);
    let target: { readonly id: string; readonly via: string | null } | null = null;
    if (emails.length === 1) {
      const email = brainEntityId("person", emails[0]!);
      const id = await rootOf(trx, scope, email);
      const via = id === email ? null : email;
      if (id === aliasId || (existing?.entity_id === id && existing.via_entity_id === via)) continue;
      target = { id, via };
    }
    if (existing !== undefined) {
      await trx.deleteFrom("brain_graph_aliases").where("owner_id", "=", scope.ownerId)
        .where("scope_id", "=", scope.scopeId).where("alias_entity_id", "=", aliasId).execute();
      await returnCarried(trx, scope, existing.entity_id, aliasId, at);
    }
    if (target !== null && await mergedCount(trx, scope, target.id) + await mergedCount(trx, scope, aliasId) + 1
      <= BRAIN_GRAPH_LIMITS.aliasesPerEntity) {
      await carryAliases(trx, scope, aliasId, target.id, at);
      await writeAlias(trx, scope, `person:${nameKey}`, target.id, target.via, "single_email_for_name", now);
    }
  }
}

/** Merged rows of the root whose via chain reaches `aliasId` (at most aliasesPerEntity rows) go back to it. */
async function returnCarried(trx: Trx, scope: BrainScopeKey, root: string, aliasId: string, at: string): Promise<void> {
  await sql`WITH RECURSIVE carried(id) AS (SELECT ${aliasId}::text
      UNION SELECT a.alias_entity_id FROM brain_graph_aliases a JOIN carried ON a.via_entity_id = carried.id
      WHERE a.owner_id = ${scope.ownerId} AND a.scope_id = ${scope.scopeId} AND a.entity_id = ${root}
        AND a.state = 'merged')
    UPDATE brain_graph_aliases SET entity_id = ${aliasId}, updated_at = ${at}::timestamptz,
      via_entity_id = CASE WHEN via_entity_id = ${aliasId} THEN NULL ELSE via_entity_id END
    WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} AND state = 'merged'
      AND alias_entity_id IN (SELECT id FROM carried)`.execute(trx);
}

/**
 * Manual merge, split or unmerge of a person alias; returns the entity id the view is about. merge: aliasKey (a
 * person entity ref with an entity row) now resolves to the entity, and aliases that resolved to it move along (via
 * it); alias_conflict when it is merged into another entity. split ("not the same person"): undoes a merge into this
 * entity and keeps a split row, and the aliases that came in through it go back to it (alias_conflict when there is
 * no such merge). unmerge (Undo of a manual merge): the manual row is deleted and the carried aliases go back, so
 * nothing of the merge is left; a `name:` alias is then decided by derivation again (alias_conflict when there is no
 * manual merge of it into this entity).
 */
export async function updateGraphAlias(
  trx: Trx, scope: BrainScopeKey, entity: string, input: BrainAliasInput, now: Date,
): Promise<string> {
  const root = await resolveRoot(trx, scope, entity);
  const alias = parseEntityInput(input.aliasKey);
  if (root.kind !== "person" || alias === null || alias.kind !== "person" || alias.entityId === root.entity_id) {
    throw new BrainApiError("invalid_request");
  }
  const aliasRow = await trx.selectFrom("brain_graph_entities").select(["entity_id", "key"])
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("entity_id", "=", alias.entityId).executeTakeFirst();
  if (aliasRow === undefined) throw new BrainFeatureError("entity_not_found");
  const existing = await aliases(trx, scope).select(["entity_id", "state", "reason"])
    .where("alias_entity_id", "=", alias.entityId).executeTakeFirst();
  const mergedHere = existing?.state === "merged" && existing.entity_id === root.entity_id;
  const at = now.toISOString();
  if (input.action === "split") {
    if (!mergedHere) throw new BrainFeatureError("alias_conflict");
    await trx.updateTable("brain_graph_aliases").set({ state: "split", updated_at: at })
      .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
      .where("alias_entity_id", "=", alias.entityId).execute();
    await returnCarried(trx, scope, root.entity_id, alias.entityId, at);
    return root.entity_id;
  }
  if (input.action === "unmerge") {
    if (!mergedHere || existing.reason !== "manual") throw new BrainFeatureError("alias_conflict");
    await trx.deleteFrom("brain_graph_aliases").where("owner_id", "=", scope.ownerId)
      .where("scope_id", "=", scope.scopeId).where("alias_entity_id", "=", alias.entityId).execute();
    await returnCarried(trx, scope, root.entity_id, alias.entityId, at);
    if (aliasRow.key.startsWith("name:")) await reconcileNameAliases(trx, scope, [aliasRow.key], now);
    return root.entity_id;
  }
  if (existing?.state === "merged" && !mergedHere) throw new BrainFeatureError("alias_conflict");
  const counts = await aliases(trx, scope).select((eb) => eb.fn.countAll<number>().as("n"))
    .where("state", "=", "merged").where("entity_id", "in", [root.entity_id, alias.entityId]).executeTakeFirstOrThrow();
  if (Number(counts.n) + (mergedHere ? 0 : 1) > BRAIN_GRAPH_LIMITS.aliasesPerEntity) {
    throw new BrainApiError("brain_capacity");
  }
  await carryAliases(trx, scope, alias.entityId, root.entity_id, at);
  await writeAlias(trx, scope, input.aliasKey, root.entity_id, null, "manual", now);
  return root.entity_id;
}
