import { z } from "zod/v4";
import { previewPairCloudResource, previewPairRevisionName } from "./cloud-resource.js";
import type { PreviewPairCloudRetirementOptions } from "./cloud-retirement.js";
import type { PreviewPairIntentRow } from "./intent-recovery.js";
import { PreviewPairConflictError } from "./repository.js";
import { PreviewPairUpstreamError, readPreviewPairJson } from "./http.js";
type Identity = Pick<PreviewPairIntentRow, "pair_id" | "generation" | "source_sha" | "publication_id">;
const Operation = z.object({ name: z.string().min(1).max(256), done: z.boolean().optional(), error: z.unknown().optional(), metadata: z.unknown().optional() });
const Page = z.object({ operations: z.array(Operation).max(100).default([]), nextPageToken: z.string().max(8192).optional(),
  unreachable: z.array(z.string().max(256)).max(16).default([]) });
// Cloud Run UpdateService uses Service as Operation.metadata (not a generic
// metadata.target field). Missing metadata never proves that a request failed.
const Metadata = z.object({ "@type": z.literal("type.googleapis.com/google.cloud.run.v2.Service"), name: z.string().max(256),
  template: z.object({ revision: z.string().max(256), containers: z.array(z.object({ env: z.array(z.object({
    name: z.string().max(128), value: z.string().max(16384).optional(),
  })).max(128) })).length(1) }) });

/** Authenticated fixed-provider reads only. No missing/partial result grants
 * deletion authority or permission to repeat a publication effect. */
export function createPreviewPairOperationReader(options: PreviewPairCloudRetirementOptions) {
  const resource = previewPairCloudResource(options.project, options.region, options.service);
  const parent = `projects/${options.project}/locations/${options.region}`;
  function operationName(value: string) {
    const suffix = value.slice(`${parent}/operations/`.length);
    if (!value.startsWith(`${parent}/operations/`) || !/^[A-Za-z0-9._~-]{1,128}$/.test(suffix) || [".", ".."].includes(suffix)) {
      throw new PreviewPairConflictError();
    }
    return value;
  }
  function belongs(raw: unknown, row: Identity) {
    const parsed = Metadata.safeParse(raw);
    if (!parsed.success) return false;
    const data = parsed.data, revision = previewPairRevisionName(options.service, row.pair_id, row.generation);
    const env = data.template.containers[0]!.env;
    const literal = (name: string, value: string) => {
      const entries = env.filter(entry => entry.name === name);
      return entries.length === 1 && entries[0]!.value === value;
    };
    return data.name === resource && [revision, `${resource}/revisions/${revision}`].includes(data.template.revision)
      && row.publication_id !== null && literal("MATRIX_PREVIEW_PAIR_PUBLICATION_ID", row.publication_id)
      && literal("MATRIX_PREVIEW_PAIR_ID", row.pair_id) && literal("MATRIX_PREVIEW_PAIR_GENERATION", String(row.generation))
      && literal("MATRIX_BUILD_SHA", row.source_sha);
  }
  async function client(row: Identity, signal: AbortSignal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const token = z.string().min(1).max(16_384).parse(await options.accessToken(deadline));
    const get = async (path: string, stage: "operation_discovery" | "publication_operation") => {
      const response = await (options.fetchImpl ?? fetch)(`https://run.googleapis.com/v2/${path}`, {
        headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: deadline });
      if (!response.ok) {
        await response.body?.cancel();
        // Private operator diagnostics only; never log tokens, URLs or bodies.
        console.warn("[preview-pair] operation probe unavailable", { pairId: row.pair_id,
          generation: row.generation, stage, status: response.status });
      }
      return response;
    };
    return { get, deadline };
  }
  return {
    validateName: operationName,
    async discover(row: Identity, signal: AbortSignal) {
      const { get, deadline } = await client(row, signal);
      let found: z.infer<typeof Operation> | undefined, next: string | undefined;
      const seen: string[] = []; // Invocation-local, at most eight page tokens.
      for (let page = 0; page < 8; page++) {
        deadline.throwIfAborted();
        const response = Page.parse(await readPreviewPairJson(await get(`${parent}/operations?pageSize=100${next ? `&pageToken=${encodeURIComponent(next)}` : ""}`, "operation_discovery"), 256 * 1024));
        if (response.unreachable.length) throw new PreviewPairUpstreamError();
        for (const candidate of response.operations) if (belongs(candidate.metadata, row)) {
          operationName(candidate.name);
          if (found) throw new PreviewPairUpstreamError();
          found = candidate;
        }
        next = response.nextPageToken;
        if (!next) break;
        if (seen.includes(next) || page === 7) throw new PreviewPairUpstreamError();
        seen.push(next);
      }
      return found; // No match is unknown, not proof that publication failed.
    },
    async read(row: Identity & { operation_name: string | null }, signal: AbortSignal) {
      const name = operationName(z.string().parse(row.operation_name));
      const { get } = await client(row, signal), response = await get(name, "publication_operation");
      if (response.status === 404) return undefined;
      const operation = Operation.parse(await readPreviewPairJson(response, 256 * 1024));
      if (operation.name !== name) throw new PreviewPairUpstreamError();
      return operation;
    },
  };
}
