import { z } from "zod/v4";
import { PreviewPairIdSchema, PreviewPairGenerationSchema, PreviewPairShaSchema, previewPairTag } from "@matrix-os/contracts/preview-pair";
import { previewPairCloudResource, previewPairRevisionName } from "./cloud-resource.js";
import { PreviewPairConflictError } from "./repository.js";
import { PreviewPairUpstreamError, readPreviewPairJson } from "./http.js";
const Target = z.strictObject({ pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema, sourceSha: PreviewPairShaSchema });
export interface PreviewPairCloudRetirementOptions {
  project: string; region: string; service: string;
  accessToken(signal: AbortSignal): Promise<string>; fetchImpl?: typeof fetch;
}
const Traffic = z.strictObject({ type: z.enum(["TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED", "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"]).optional(),
  revision: z.string().min(1).max(256).optional(), percent: z.number().int().min(0).max(100).optional(), tag: z.string().min(1).max(63).optional() });
const Service = z.object({ name: z.string(), etag: z.string().min(1).max(256), reconciling: z.literal(false).optional(),
  traffic: z.array(Traffic).min(1).max(128), trafficStatuses: z.array(Traffic.extend({ uri: z.string().max(512).optional() })).min(1).max(128) });
const Revision = z.object({ name: z.string(), etag: z.string().min(1).max(256), containers: z.array(z.object({
  env: z.array(z.object({ name: z.string().max(128), value: z.string().max(16_384).optional() })).max(128),
})).length(1) });

/** Only a supplied, fresh canonical ledger check grants mutation authority.
 * An acknowledgement never proves removal: observe tags/revision absent later. */
export function createPreviewPairCloudRetirement(options: PreviewPairCloudRetirementOptions) {
  const resource = previewPairCloudResource(options.project, options.region, options.service);
  return async (authorize: () => Promise<z.infer<typeof Target>>, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    const target = Target.parse(await authorize());
    async function check() {
      signal.throwIfAborted();
      const fresh = Target.parse(await authorize());
      if (fresh.pairId !== target.pairId || fresh.generation !== target.generation || fresh.sourceSha !== target.sourceSha) throw new PreviewPairConflictError();
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const token = z.string().min(1).max(16_384).parse(await options.accessToken(deadline));
    const request = (path: string, init: RequestInit = {}) => {
      deadline.throwIfAborted();
      return (options.fetchImpl ?? fetch)(`https://run.googleapis.com/v2/${path}`, { ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        redirect: "error", signal: deadline });
    };
    const result = await request(resource);
    if (result.status === 404) { await result.body?.cancel(); await check(); return true; }
    if (!result.ok) { await result.body?.cancel(); throw new PreviewPairUpstreamError(); }
    const service = Service.parse(await readPreviewPairJson(result, 256 * 1024));
    if (service.name !== resource) throw new PreviewPairUpstreamError();
    const name = previewPairRevisionName(options.service, target.pairId, target.generation), revisionPath = `${resource}/revisions/${name}`;
    const tags = [previewPairTag(target.pairId, target.generation, "ui"), previewPairTag(target.pairId, target.generation, "api")];
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
      if (revision.name !== revisionPath || literal("MATRIX_PREVIEW_PAIR_ID") !== target.pairId
        || literal("MATRIX_PREVIEW_PAIR_GENERATION") !== String(target.generation)
        || literal("MATRIX_BUILD_SHA") !== target.sourceSha) throw new PreviewPairUpstreamError();
    }
    if (service.traffic.some(owned)) {
      if (!revision) throw new PreviewPairUpstreamError();
      await check();
      const patched = await request(`${resource}?updateMask=traffic`, { method: "PATCH",
        body: JSON.stringify({ name: resource, etag: service.etag, traffic: kept }) });
      await patched.body?.cancel();
      if (!patched.ok && ![409, 412].includes(patched.status)) throw new PreviewPairUpstreamError();
      await check(); return false;
    }
    if (service.trafficStatuses.some(owned)) return false;
    if (!revision) { await check(); return true; }
    await check();
    const deleted = await request(`${revisionPath}?etag=${encodeURIComponent(revision.etag)}`, { method: "DELETE" });
    await deleted.body?.cancel();
    if (!deleted.ok && ![404, 409, 412].includes(deleted.status)) throw new PreviewPairUpstreamError();
    await check(); return false;
  };
}
