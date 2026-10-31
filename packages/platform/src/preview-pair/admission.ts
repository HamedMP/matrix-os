import { z } from "zod/v4";
import { sql } from "kysely";
import { PreviewPairActorSchema, PreviewPairIdSchema, PreviewPairPrSchema, PreviewPairShaSchema, previewPairTag } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import { PreviewPairCandidateSchema } from "./provenance.js";
import { PreviewPairConflictError, readPreviewPair, prepareLeasedPairMembers, recordPreviewPairCurrency, type PreparePairMember } from "./repository.js";

const Request = z.strictObject({ pairId: PreviewPairIdSchema, pr: PreviewPairPrSchema,
  requesterId: PreviewPairActorSchema, sourceSha: PreviewPairShaSchema, candidate: PreviewPairCandidateSchema });
export type PreviewPairAdmissionRequest = z.infer<typeof Request>;
export type { PreparePairMember } from "./repository.js";

/** Both member/job writes and the free fixture lease share the original admission boundary. */
export async function promoteQueuedPreviewPair(db: PlatformDB, config: EnabledPreviewPairConfig,
  pairId: string, revision: number, prepare: PreparePairMember, now: number) {
  PreviewPairIdSchema.parse(pairId); z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(revision);
  if (!Number.isFinite(now)) throw new PreviewPairConflictError();
  return db.transaction(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('preview-pair-admission', 0))`.execute(trx.executor);
    const pair = await trx.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", pairId)
      .where("revision", "=", revision).where("state", "=", "queued").forUpdate().executeTakeFirst();
    if (!pair || Date.parse(pair.expires_at) <= now) throw new PreviewPairConflictError();
    const available = await trx.executor.selectFrom("preview_pair_fixtures").selectAll()
      .where("fixture_id", "in", config.fixtures.map(f => f.id)).where("active_pair_id", "is", null)
      .orderBy("fixture_id").forUpdate().executeTakeFirst();
    if (!available) return trx.executor.updateTable("preview_pairs")
      .set({ next_attempt_at: new Date(now + 15_000).toISOString(), revision: sql`revision + 1` })
      .where("pair_id", "=", pairId).where("revision", "=", revision).where("state", "=", "queued")
      .returningAll().executeTakeFirstOrThrow();
    const approved = config.fixtures.find(f => f.id === available.fixture_id);
    if (!approved || approved.ownerActorId !== available.owner_actor_id || approved.memberActorId !== available.member_actor_id
      || approved.outsiderActorId !== available.outsider_actor_id || approved.organizationId !== available.organization_id) throw new PreviewPairConflictError();
    await trx.executor.updateTable("preview_pair_fixtures").set({ active_pair_id: pairId, revision: sql`revision + 1` })
      .where("fixture_id", "=", available.fixture_id).where("active_pair_id", "is", null).where("revision", "=", available.revision)
      .returning("fixture_id").executeTakeFirstOrThrow();
    const updated = await trx.executor.updateTable("preview_pairs").set({ state: "preparing", fixture_id: available.fixture_id,
      revision: sql`revision + 1`, next_attempt_at: null }).where("pair_id", "=", pairId).where("revision", "=", revision)
      .where("state", "=", "queued").returningAll().executeTakeFirstOrThrow();
    await prepareLeasedPairMembers(trx, pairId, updated.generation, prepare);
    return updated;
  });
}

/** Called only after independent controller provenance verification. No provider dispatch. */
export async function admitPreviewPair(db: PlatformDB, config: EnabledPreviewPairConfig,
  raw: unknown, prepare: PreparePairMember, now: number) {
  const input = Request.parse(raw);
  if (!Number.isFinite(now) || input.sourceSha !== input.candidate.sourceSha) throw new PreviewPairConflictError();
  return db.transaction(async trx => {
  // Shared across service instances; fixture/config and queue checks belong to
  // the same admission boundary as both owners' quota and deletion locks.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('preview-pair-admission', 0))`.execute(trx.executor);
  const retainedFixtures = await trx.executor.selectFrom("preview_pair_fixtures").selectAll().execute();
  if (retainedFixtures.length > 8 || new Set([...retainedFixtures.map(f => f.fixture_id), ...config.fixtures.map(f => f.id)]).size > 8) throw new PreviewPairConflictError();
  for (const fixture of config.fixtures) {
    const old = retainedFixtures.find(row => row.fixture_id === fixture.id);
    if (old && (old.owner_actor_id !== fixture.ownerActorId || old.member_actor_id !== fixture.memberActorId
      || old.outsider_actor_id !== fixture.outsiderActorId || old.organization_id !== fixture.organizationId)) throw new PreviewPairConflictError();
    for (const row of retainedFixtures) if (row.fixture_id !== fixture.id &&
      ([row.owner_actor_id, row.member_actor_id].some(actor => [fixture.ownerActorId, fixture.memberActorId, fixture.outsiderActorId].includes(actor))
       || [fixture.ownerActorId, fixture.memberActorId].includes(row.outsider_actor_id))) throw new PreviewPairConflictError();
    await trx.executor.insertInto("preview_pair_fixtures").values({ fixture_id: fixture.id,
      owner_actor_id: fixture.ownerActorId, member_actor_id: fixture.memberActorId,
      outsider_actor_id: fixture.outsiderActorId, organization_id: fixture.organizationId })
      .onConflict(oc => oc.column("fixture_id").doNothing()).execute();
  }
  const existing = await trx.executor.selectFrom("preview_pairs").selectAll()
    .where("repository", "=", "HamedMP/matrix-os").where("pr", "=", input.pr).where("state", "!=", "stopped").executeTakeFirst();
  if (existing) return recordPreviewPairCurrency(trx, existing, input.sourceSha);
  for (const kind of ["ui", "api"] as const) {
    const origin = kind === "ui" ? input.candidate.browserOrigin : input.candidate.apiOrigin;
    if (!origin.startsWith(`https://${previewPairTag(input.pairId, 1, kind)}---`)) throw new PreviewPairConflictError();
  }
  const queued = await trx.executor.selectFrom("preview_pairs").select("pair_id").where("state", "=", "queued").execute();
  if (queued.length >= config.maxQueued) throw new PreviewPairConflictError();
  const available = await trx.executor.selectFrom("preview_pair_fixtures").selectAll()
    .where("fixture_id", "in", config.fixtures.map(f => f.id)).where("active_pair_id", "is", null)
    .orderBy("fixture_id").forUpdate().executeTakeFirst();
  const createdAt = new Date(now).toISOString();
  await trx.executor.insertInto("preview_pairs").values({ pair_id: input.pairId, repository: "HamedMP/matrix-os",
    pr: input.pr, requester_id: input.requesterId, source_sha: input.sourceSha,
    state: available ? "preparing" : "queued", fixture_id: available?.fixture_id ?? null,
    created_at: createdAt, expires_at: new Date(now + config.maxLifetimeMs).toISOString() }).execute();
  await trx.executor.insertInto("preview_pair_generations").values({ pair_id: input.pairId, generation: 1,
    source_sha: input.sourceSha, candidate: JSON.stringify(input.candidate), created_at: createdAt }).execute();
  if (available) {
    await trx.executor.updateTable("preview_pair_fixtures").set({ active_pair_id: input.pairId,
      revision: sql`revision + 1` }).where("fixture_id", "=", available.fixture_id)
      .where("active_pair_id", "is", null).where("revision", "=", available.revision).returning("fixture_id").executeTakeFirstOrThrow();
    await prepareLeasedPairMembers(trx, input.pairId, 1, prepare);
  }
  return (await readPreviewPair(trx, input.pairId))!;
  });
}
