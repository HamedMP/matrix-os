import type { PlatformDB } from "../db.js";
import { z } from "zod/v4";
import { previewPairHandle, previewPairTag, PreviewPairDigestSchema } from "@matrix-os/contracts/preview-pair";
import type { PreviewPairCleanupMember } from "./cleanup.js";
import { withPreviewPairClaim, type PreviewPairClaim } from "./lifecycle.js";
import { PreviewPairConflictError } from "./repository.js";
import { PreviewPairCandidateSchema } from "./provenance.js";
import { previewPairCloudResource, previewPairRevisionName } from "./cloud-resource.js";
import { PreviewPairUpstreamError, readPreviewPairJson } from "./http.js";
export interface PreviewPairCloudCleanupOptions {
  db: PlatformDB; profileFingerprint?: string; project: string; region: string; service: string;
  accessToken: (signal: AbortSignal) => Promise<string>; fetchImpl?: typeof fetch; now: () => number;
}
const Traffic = z.strictObject({ type: z.enum(["TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED", "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"]).optional(),
  revision: z.string().min(1).max(256).optional(), percent: z.number().int().min(0).max(100).optional(), tag: z.string().min(1).max(63).optional() });
const Service = z.object({ name: z.string(), etag: z.string().min(1).max(256), reconciling: z.literal(false).optional(),
  traffic: z.array(Traffic).min(1).max(128), trafficStatuses: z.array(Traffic.extend({ uri: z.string().max(512).optional() })).min(1).max(128) });
const Revision = z.object({ name: z.string(), etag: z.string().min(1).max(256), containers: z.array(z.object({
  env: z.array(z.object({ name: z.string().max(128), value: z.string().max(16_384).optional() })).max(128),
})).length(1) });

/** No cloud call runs in a ledger transaction. Acknowledgements never prove
 * retirement. Exact tags and revision must be observed absent in a later pass. */
export function createPreviewPairCloudCleanup(options: PreviewPairCloudCleanupOptions) {
  if (options.profileFingerprint !== undefined) PreviewPairDigestSchema.parse(options.profileFingerprint);
  const resource = previewPairCloudResource(options.project, options.region, options.service);
  async function canonical(member: PreviewPairCleanupMember, claim: PreviewPairClaim) {
    return withPreviewPairClaim(options.db, claim, options.now(), async trx => {
      const pair = await trx.executor.selectFrom("preview_pairs").select(["state", "pr"]).where("pair_id", "=", claim.pairId).executeTakeFirstOrThrow();
      if (member.pairId !== claim.pairId || member.generation > claim.generation || !["cleanup_pending", "updating"].includes(pair.state)) throw new PreviewPairConflictError();
      const row = await trx.executor.selectFrom("preview_pair_members as member")
        .innerJoin("user_machines as machine", "machine.machine_id", "member.machine_id")
        .innerJoin("preview_pair_generations as generation", join => join.onRef("generation.pair_id", "=", "member.pair_id").onRef("generation.generation", "=", "member.generation"))
        .select(["member.role", "generation.candidate", "generation.source_sha"])
        .where("member.pair_id", "=", member.pairId).where("member.generation", "=", member.generation)
        .where("member.machine_id", "=", member.machineId).where("member.job_id", "=", member.jobId)
        .where("member.actor_id", "=", member.actorId).where("member.handle", "=", member.handle)
        .where("machine.clerk_user_id", "=", member.actorId).where("machine.handle", "=", member.handle)
        .where("machine.runtime_slot", "=", member.handle).where("machine.provisioning_class", "=", "preview").executeTakeFirst();
      if (!row || member.handle !== previewPairHandle(pair.pr, member.pairId, member.generation, row.role)) throw new PreviewPairConflictError();
      const candidate = PreviewPairCandidateSchema.parse(row.candidate);
      if (options.profileFingerprint && candidate.sourceProfileFingerprint !== options.profileFingerprint) throw new PreviewPairConflictError();
      if (candidate.sourceSha !== row.source_sha) throw new PreviewPairConflictError();
      return candidate;
    });
  }
  return async (member: PreviewPairCleanupMember, claim: PreviewPairClaim, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    const candidate = await canonical(member, claim);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const token = z.string().min(1).max(16_384).parse(await options.accessToken(deadline));
    const request = (path: string, init: RequestInit = {}) => {
      deadline.throwIfAborted();
      return (options.fetchImpl ?? fetch)(`https://run.googleapis.com/v2/${path}`, { ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        redirect: "error", signal: deadline });
    };
    const result = await request(resource);
    if (result.status === 404) { await result.body?.cancel(); await canonical(member, claim); return true; }
    if (!result.ok) { await result.body?.cancel(); throw new PreviewPairUpstreamError(); }
    const service = Service.parse(await readPreviewPairJson(result, 256 * 1024));
    if (service.name !== resource) throw new PreviewPairUpstreamError();
    const name = previewPairRevisionName(options.service, member.pairId, member.generation), revisionPath = `${resource}/revisions/${name}`;
    const tags = [previewPairTag(member.pairId, member.generation, "ui"), previewPairTag(member.pairId, member.generation, "api")];
    const owned = (entry: z.infer<typeof Traffic>) => entry.tag !== undefined && tags.includes(entry.tag);
    const matches = (entry: z.infer<typeof Traffic>) => entry.revision === name || entry.revision === revisionPath;
    if ([...service.traffic, ...service.trafficStatuses].some(entry => owned(entry) && (!matches(entry) || (entry.percent ?? 0) !== 0)
      || matches(entry) && (!owned(entry) || (entry.percent ?? 0) !== 0))) throw new PreviewPairUpstreamError();
    const kept = service.traffic.filter(entry => !owned(entry));
    if (!kept.length || kept.reduce((sum, entry) => sum + (entry.percent ?? 0), 0) !== 100) throw new PreviewPairUpstreamError();
    const revisionResponse = await request(revisionPath);
    const absent = revisionResponse.status === 404;
    if (absent) await revisionResponse.body?.cancel();
    else if (!revisionResponse.ok) { await revisionResponse.body?.cancel(); throw new PreviewPairUpstreamError(); }
    const revision = absent ? null : Revision.parse(await readPreviewPairJson(revisionResponse, 256 * 1024));
    if (revision) {
      const env = revision.containers[0]!.env;
      const literal = (key: string) => { const values = env.filter(entry => entry.name === key); if (values.length !== 1) throw new PreviewPairUpstreamError(); return values[0]!.value; };
      if (revision.name !== revisionPath || literal("MATRIX_PREVIEW_PAIR_ID") !== member.pairId
        || literal("MATRIX_PREVIEW_PAIR_GENERATION") !== String(member.generation)
        || literal("MATRIX_BUILD_SHA") !== candidate.platformSource.sha) throw new PreviewPairUpstreamError();
    }
    if (service.traffic.some(owned)) {
      if (!revision) throw new PreviewPairUpstreamError();
      await canonical(member, claim);
      const patched = await request(`${resource}?updateMask=traffic`, { method: "PATCH",
        body: JSON.stringify({ name: resource, etag: service.etag, traffic: kept }) });
      await patched.body?.cancel();
      if (!patched.ok && ![409, 412].includes(patched.status)) throw new PreviewPairUpstreamError();
      await canonical(member, claim); return false;
    }
    if (service.trafficStatuses.some(owned)) return false;
    if (!revision) { await canonical(member, claim); return true; }
    await canonical(member, claim);
    const deleted = await request(`${revisionPath}?etag=${encodeURIComponent(revision.etag)}`, { method: "DELETE" });
    await deleted.body?.cancel();
    if (!deleted.ok && ![404, 409, 412].includes(deleted.status)) throw new PreviewPairUpstreamError();
    await canonical(member, claim); return false;
  };
}
