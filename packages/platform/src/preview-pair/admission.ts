import { z } from "zod/v4";
import { sql } from "kysely";
import { PreviewPairActorSchema, PreviewPairIdSchema, PreviewPairPrSchema, PreviewPairShaSchema, previewPairTag } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import { PreviewPairCandidateSchema } from "./provenance.js";
import { PreviewPairConflictError, readPreviewPair, prepareLeasedPairMembers, type PreparePairMember } from "./repository.js";

const Request = z.strictObject({ pairId: PreviewPairIdSchema, pr: PreviewPairPrSchema,
  requesterId: PreviewPairActorSchema, sourceSha: PreviewPairShaSchema, candidate: PreviewPairCandidateSchema });
export type PreviewPairAdmissionRequest = z.infer<typeof Request>;
export type { PreparePairMember } from "./repository.js";

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
  if (existing) {
    if (existing.source_sha !== input.sourceSha) {
      return trx.executor.updateTable("preview_pairs").set({ outdated: true, requested_source_sha: input.sourceSha,
        revision: sql`revision + 1` }).where("pair_id", "=", existing.pair_id).where("revision", "=", existing.revision)
        .returningAll().executeTakeFirstOrThrow();
    }
    return existing;
  }
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
