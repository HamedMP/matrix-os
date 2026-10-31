import { PreviewPairIdSchema, parseLivePreviewPairManifest } from "../../packages/contracts/src/preview-pair.js";
import { PreviewPairControlOriginSchema, PreviewPairSetupSchema, PreviewPairPreparedSchema, PreviewPairAdmissionResultSchema,
  PreviewPairControllerStatusResultSchema, PreviewPairReportSelectionSchema, PreviewPairRequestReportSchema,
  type PreviewPairControllerReceipt } from "../../packages/contracts/src/preview-pair-control.js";
import { PreviewPairPrepareRequestSchema, PreviewPairStartSchema, PreviewPairPublishSchema, PreviewPairRequestStopSchema,
  PreviewPairControllerStatusSchema, PreviewPairReaderStopSchema, PreviewPairUpdateAdoptionSchema, PreviewPairActionSchema }
  from "../../packages/platform/src/preview-pair/api-contracts.js";
import { PreviewPairPublicationResultSchema } from "../../packages/platform/src/preview-pair/publication-contract.js";
import { readPreviewPairJson } from "../../packages/platform/src/preview-pair/http.js";
import { PreviewPairArtifactCredentialSchema } from "../../packages/contracts/src/preview-pair-artifact.js";

export class PreviewPairControlUnavailable extends Error {
  constructor(readonly status: number | null = null) { super("Preview pair is unavailable"); }
}
function observed<T>(schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } }, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new PreviewPairControlUnavailable();
  return result.data;
}

/** One explicitly selected first-party control origin. No bearer, fallback or
 * redirect can be supplied by a manifest, candidate, response or environment. */
export function createPreviewPairControlClient(options: { origin: string; token: string; fetchImpl?: typeof fetch; now?: () => number }) {
  const origin = PreviewPairControlOriginSchema.safeParse(options.origin), token = PreviewPairArtifactCredentialSchema.safeParse(options.token);
  if (!origin.success || !token.success) throw new PreviewPairControlUnavailable();
  async function json(path: string, body?: unknown, timeoutMs = 10_000) {
    try {
      const response = await (options.fetchImpl ?? fetch)(`${origin.data}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token.data}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { await response.body?.cancel(); throw new PreviewPairControlUnavailable(response.status); }
      return await readPreviewPairJson(response, 64 * 1024);
    } catch (error: unknown) {
      if (error instanceof PreviewPairControlUnavailable) throw error;
      console.warn("[preview-pair] control observation unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new PreviewPairControlUnavailable();
    }
  }
  const id = (pairId: string) => PreviewPairIdSchema.parse(pairId);
  return {
    origin: origin.data,
    async setup() { return observed(PreviewPairSetupSchema, await json("/api/preview-pairs/setup")); },
    async prepare(request: PreviewPairControllerReceipt) {
      const body = PreviewPairPrepareRequestSchema.parse({ repository: "HamedMP/matrix-os", pairId: request.pairId,
        generation: request.generation, pr: request.pr, sourceSha: request.sourceSha, controllerRunId: request.runId });
      const result = observed(PreviewPairPreparedSchema, await json("/vps/preview-pairs/requests", body, 30_000));
      if (result.kind === "request" ? result.pairId !== request.pairId || result.generation !== request.generation : result.pr !== request.pr) {
        throw new PreviewPairControlUnavailable();
      }
      return result;
    },
    async publish(request: PreviewPairControllerReceipt, imageSha256: string) {
      const body = PreviewPairPublishSchema.parse({ generation: request.generation, controllerRunId: request.runId, imageSha256 });
      return observed(PreviewPairPublicationResultSchema, await json(`/vps/preview-pairs/requests/${id(request.pairId)}/publication`, body, 30_000));
    },
    async start(request: PreviewPairControllerReceipt, candidate: unknown) {
      const body = PreviewPairStartSchema.parse({ repository: "HamedMP/matrix-os", pairId: request.pairId,
        pr: request.pr, sourceSha: request.sourceSha, controllerRunId: request.runId, candidate });
      const result = observed(PreviewPairAdmissionResultSchema, await json("/vps/preview-pairs", body, 30_000));
      if (result.pr !== request.pr || result.ownedRequest && result.pairId !== request.pairId) throw new PreviewPairControlUnavailable();
      return result;
    },
    async adopt(request: PreviewPairControllerReceipt, baseGeneration: number, baseSourceSha: string, candidate: unknown) {
      if (request.generation !== baseGeneration + 1) throw new PreviewPairControlUnavailable();
      const body = PreviewPairUpdateAdoptionSchema.parse({ baseGeneration, baseSourceSha, controllerRunId: request.runId, candidate });
      const result = observed(PreviewPairAdmissionResultSchema, await json(`/vps/preview-pairs/${id(request.pairId)}/adoption`, body, 30_000));
      if (result.pairId !== request.pairId || result.pr !== request.pr || !result.ownedRequest) throw new PreviewPairControlUnavailable();
      return result;
    },
    async status(request: PreviewPairControllerReceipt) {
      const body = PreviewPairControllerStatusSchema.parse({ generation: request.generation, controllerRunId: request.runId });
      const result = observed(PreviewPairControllerStatusResultSchema, await json(`/vps/preview-pairs/${id(request.pairId)}/status`, body));
      if (result.pairId !== request.pairId || result.generation !== request.generation || result.pr !== request.pr || result.sourceSha !== request.sourceSha) {
        throw new PreviewPairControlUnavailable();
      }
      return result;
    },
    async stopRequest(request: PreviewPairControllerReceipt) {
      const body = PreviewPairRequestStopSchema.parse({ type: "stop", generation: request.generation, controllerRunId: request.runId });
      return json(`/vps/preview-pairs/requests/${id(request.pairId)}/actions`, body);
    },
    async stopOwned(request: PreviewPairControllerReceipt) {
      const current = await this.status(request);
      if (current.kind === "request") return this.stopRequest(request);
      const body = PreviewPairActionSchema.parse({ type: "stop", generation: current.currentGeneration, revision: current.revision });
      return json(`/vps/preview-pairs/${id(request.pairId)}/actions`, body);
    },
    async report(pairId: string) {
      const raw = await json(`/api/preview-pairs/${id(pairId)}`);
      const request = PreviewPairRequestReportSchema.safeParse(raw);
      const result = request.success ? request.data : observed(PreviewPairReportSelectionSchema, raw);
      if (result.pairId !== pairId) throw new PreviewPairControlUnavailable();
      return result;
    },
    async stop(pairId: string, generation: number, revision: number) {
      const body = PreviewPairReaderStopSchema.parse({ generation, revision });
      return json(`/api/preview-pairs/${id(pairId)}/stop`, body);
    },
    async manifest(pairId: string) {
      const result = parseLivePreviewPairManifest(await json(`/api/preview-pairs/${id(pairId)}/manifest`, undefined, 30_000), options.now?.());
      if (result.pairId !== pairId) throw new PreviewPairControlUnavailable();
      return result;
    },
  };
}
