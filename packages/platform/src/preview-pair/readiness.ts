import { z } from "zod/v4";
import { sql } from "kysely";
import { PreviewPairMemberSchema, parseLivePreviewPairManifest, type PreviewPairManifest, type PreviewPairRole } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import { PreviewPairCandidateSchema, type PreviewPairCandidate } from "./provenance.js";
import { withPreviewPairClaim, type PreviewPairClaim } from "./lifecycle.js";
import { PreviewPairConflictError } from "./repository.js";
import type { PreviewPairFailureStage } from "./api-contracts.js";

export interface PreviewPairReadinessMember {
  role: PreviewPairRole; machineId: string; actorId: string; handle: string; tokenEpoch: number;
}
export interface PreviewPairReadinessAdapters {
  /** Independently verify current approved service/data/identity/signing bindings. */
  authority(candidate: PreviewPairCandidate, signal: AbortSignal): Promise<boolean>;
  /** Current membership in the configured test identity instance, never a UI-selected org. */
  membership(actorId: string, organizationId: string, signal: AbortSignal): Promise<boolean>;
  observe(member: PreviewPairReadinessMember, signal: AbortSignal): Promise<unknown>;
  funding(member: PreviewPairReadinessMember, signal: AbortSignal): Promise<unknown>;
}
const Observation = PreviewPairMemberSchema.extend({ healthy: z.literal(true),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.iso.datetime({ offset: true }) });
const Funding = z.strictObject({ source: z.literal("preview-test"), machineId: z.uuid(), actorId: z.string(),
  tokenEpoch: z.number().int().positive(), remainingMicrousd: z.number().int().positive(),
  expiresAt: z.iso.datetime({ offset: true }) });
export const PersistedPreviewPairObservationSchema = Observation.extend({ funding: Funding,
  verifiedAt: z.iso.datetime({ offset: true }) });
export class PreviewPairReadinessFailure extends PreviewPairConflictError {
  constructor(readonly stage: PreviewPairFailureStage) { super(); this.name = "PreviewPairReadinessFailure"; }
}
function proof<T>(schema: z.ZodType<T>, raw: unknown, stage: PreviewPairFailureStage): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new PreviewPairReadinessFailure(stage);
  return parsed.data;
}

async function boundedRead<T>(work: (signal: AbortSignal) => Promise<T>, stage: PreviewPairFailureStage = "readiness_unavailable"): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(controller.signal), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PreviewPairConflictError()); }, 10_000);
      timer.unref?.();
    })]);
  } catch (error: unknown) {
    console.warn("[preview-pair] readiness probe unavailable", stage, error instanceof Error ? error.name : "UnknownError");
    throw new PreviewPairReadinessFailure(stage);
  } finally { if (timer) clearTimeout(timer); }
}

/** Infrastructure readiness neither creates a project/grant nor passes product acceptance. */
export async function refreshPreviewPairReadiness(db: PlatformDB, claim: PreviewPairClaim,
  config: EnabledPreviewPairConfig, adapters: PreviewPairReadinessAdapters, now: () => number): Promise<PreviewPairManifest> {
  const snapshot = await withPreviewPairClaim(db, claim, now(), async trx => {
    const pair = await trx.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", claim.pairId).executeTakeFirstOrThrow();
    if (!pair.fixture_id || !["preparing", "ready"].includes(pair.state) || Date.parse(pair.expires_at) <= now()) throw new PreviewPairConflictError();
    const fixture = await trx.executor.selectFrom("preview_pair_fixtures").selectAll().where("fixture_id", "=", pair.fixture_id)
      .where("active_pair_id", "=", pair.pair_id).executeTakeFirstOrThrow();
    const generation = await trx.executor.selectFrom("preview_pair_generations").selectAll().where("pair_id", "=", pair.pair_id)
      .where("generation", "=", claim.generation).executeTakeFirstOrThrow();
    const members = await trx.executor.selectFrom("preview_pair_members as member").innerJoin("user_machines as machine", "machine.machine_id", "member.machine_id")
      .select(["member.role", "member.machine_id", "member.actor_id", "member.handle", "member.retired_at",
        "machine.runtime_slot", "machine.runtime_token_epoch", "machine.provisioning_class", "machine.clerk_user_id",
        "machine.deleted_at", "machine.access_clerk_user_ids", "machine.status", "machine.image_version"])
      .where("member.pair_id", "=", pair.pair_id).where("member.generation", "=", claim.generation).execute();
    return { pair, fixture, candidate: PreviewPairCandidateSchema.parse(generation.candidate), members };
  });
  try {
    const verifiedAt = new Date(now()).toISOString();
    const { pair, fixture, candidate, members } = snapshot;
    if (members.length !== 2 || candidate.identityIssuer !== config.identityIssuer || candidate.sourceSha !== pair.source_sha) throw new PreviewPairConflictError();
    const observedMembers: Partial<PreviewPairManifest["members"]> = {};
    const observationRows: Array<{ machineId: string; observation: string }> = [];
    let fundingExpiry = Date.parse(pair.expires_at);
    const authority = await boundedRead(signal => adapters.authority(candidate, signal), "authority");
    const memberships = await Promise.all([fixture.owner_actor_id, fixture.member_actor_id, fixture.outsider_actor_id]
      .map(actor => boundedRead(signal => adapters.membership(actor, fixture.organization_id, signal), "membership")));
    if (authority !== true) throw new PreviewPairReadinessFailure("authority");
    if (memberships[0] !== true || memberships[1] !== true || memberships[2] !== false) throw new PreviewPairReadinessFailure("membership");
    await Promise.all(members.map(async member => {
      if (member.retired_at || member.deleted_at || member.status !== "running" || member.provisioning_class !== "preview"
        || member.runtime_slot !== member.handle || member.clerk_user_id !== member.actor_id || member.access_clerk_user_ids.length
        || member.image_version !== candidate.hostBundleVersion
        || member.actor_id !== (member.role === "owner" ? fixture.owner_actor_id : fixture.member_actor_id)) throw new PreviewPairReadinessFailure(`${member.role}_runtime`);
      const expected: PreviewPairReadinessMember = { role: member.role, machineId: member.machine_id,
        actorId: member.actor_id, handle: member.handle, tokenEpoch: member.runtime_token_epoch };
      const [rawObservation, rawFunding] = await Promise.all([boundedRead(signal => adapters.observe(expected, signal), `${member.role}_runtime`),
        boundedRead(signal => adapters.funding(expected, signal), `${member.role}_funding`)]);
      const observation = proof(Observation, rawObservation, `${member.role}_runtime`);
      const funding = proof(Funding, rawFunding, `${member.role}_funding`);
      const observedAt = Date.parse(observation.observedAt);
      if (observation.role !== expected.role || observation.machineId !== expected.machineId || observation.actorId !== expected.actorId
        || observation.runtimeSlot !== expected.handle || observation.handle !== expected.handle
        || now() - observedAt > 30_000 || observedAt > now() + 5_000) throw new PreviewPairReadinessFailure(`${member.role}_runtime`);
      if (observation.installedVersion !== candidate.hostBundleVersion || observation.bundleSha256 !== candidate.hostBundleSha256
        || observation.installedSha !== pair.source_sha || observation.runningSha !== pair.source_sha) throw new PreviewPairReadinessFailure(`${member.role}_source`);
      const controlAt = Date.parse(observation.lastControlAt);
      if (now() - controlAt > 60_000 || controlAt > now() + 5_000) throw new PreviewPairReadinessFailure(`${member.role}_control`);
      if (funding.machineId !== expected.machineId || funding.actorId !== expected.actorId || funding.tokenEpoch !== expected.tokenEpoch
        || Date.parse(funding.expiresAt) <= now()) throw new PreviewPairReadinessFailure(`${member.role}_funding`);
      fundingExpiry = Math.min(fundingExpiry, Date.parse(funding.expiresAt));
      const { healthy: _healthy, bundleSha256: _digest, observedAt: _at, ...projected } = observation;
      observedMembers[member.role] = projected;
      observationRows.push({ machineId: member.machine_id, observation: JSON.stringify({ ...observation, funding, verifiedAt }) });
    }));
    const manifest = parseLivePreviewPairManifest({ schemaVersion: 1, repository: pair.repository, pairId: pair.pair_id,
      generation: pair.generation, pr: pair.pr, sourceSha: pair.source_sha, state: "ready", outdated: pair.outdated,
      createdAt: pair.created_at, expiresAt: pair.expires_at, fundingExpiresAt: new Date(fundingExpiry).toISOString(),
      organizationId: fixture.organization_id, outsiderActorId: fixture.outsider_actor_id, identityIssuer: candidate.identityIssuer,
      browserOrigin: candidate.browserOrigin, apiOrigin: candidate.apiOrigin, platformSource: candidate.platformSource,
      dataPolicy: "reset", members: observedMembers, desktopArtifacts: candidate.desktopArtifacts }, now());
    await withPreviewPairClaim(db, claim, now(), async trx => {
      for (const row of observationRows) await trx.executor.updateTable("preview_pair_members").set({ observation: row.observation })
        .where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation).where("machine_id", "=", row.machineId).execute();
      await trx.executor.updateTable("preview_pair_generations").set({ ready_at: sql`COALESCE(ready_at, ${new Date(now()).toISOString()})` })
        .where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation).execute();
      await trx.executor.updateTable("preview_pairs").set({ state: "ready", failure_code: null, revision: sql`revision + 1`,
        claim_id: null, claim_expires_at: null }).where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation)
        .where("revision", "=", claim.revision).where("claim_id", "=", claim.claimId).executeTakeFirstOrThrow();
    });
    return manifest;
  } catch (error: unknown) {
    console.warn("[preview-pair] readiness unavailable", error instanceof Error ? error.name : "UnknownError");
    try {
      await withPreviewPairClaim(db, claim, now(), async trx => {
        await trx.executor.updateTable("preview_pairs").set({ state: "preparing", failure_code: error instanceof PreviewPairReadinessFailure ? error.stage : "readiness_unavailable",
          revision: sql`revision + 1`, claim_id: null, claim_expires_at: null }).where("pair_id", "=", claim.pairId)
          .where("generation", "=", claim.generation).where("revision", "=", claim.revision).where("claim_id", "=", claim.claimId).execute();
      });
    } catch (recordError: unknown) {
      console.warn("[preview-pair] readiness result superseded", recordError instanceof Error ? recordError.name : "UnknownError");
    }
    throw new PreviewPairConflictError();
  }
}
