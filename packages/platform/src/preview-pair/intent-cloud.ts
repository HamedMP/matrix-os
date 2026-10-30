import { z } from "zod/v4";
import { sql } from "kysely";
import { PreviewPairDigestSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import { createPreviewPairCloudRetirement, type PreviewPairCloudRetirementOptions } from "./cloud-retirement.js";
import { previewPairCloudResource, previewPairRevisionName } from "./cloud-resource.js";
import { withPreviewPairIntentClaim, type PreviewPairIntentRetirement, type PreviewPairIntentRow } from "./intent-recovery.js";
import { PreviewPairConflictError } from "./repository.js";
import { PreviewPairUpstreamError, readPreviewPairJson } from "./http.js";

const Operation = z.object({ name: z.string().min(1).max(256), done: z.boolean().optional(), metadata: z.unknown().optional() });
const Page = z.object({ operations: z.array(Operation).max(100).default([]), nextPageToken: z.string().max(8192).optional(),
  unreachable: z.array(z.string().max(256)).max(16).default([]) });
// Cloud Run UpdateService uses Service as Operation.metadata (not a generic
// metadata.target field). Missing metadata never proves that a request failed.
const Metadata = z.object({ "@type": z.literal("type.googleapis.com/google.cloud.run.v2.Service"), name: z.string().max(256),
  template: z.object({ revision: z.string().max(256), containers: z.array(z.object({ env: z.array(z.object({
    name: z.string().max(128), value: z.string().max(16384).optional(),
  })).max(128) })).length(1) }) });

export function createPreviewPairIntentCloudCleanup(options: PreviewPairCloudRetirementOptions & {
  db: PlatformDB; profileFingerprint: string; now: () => number;
}): PreviewPairIntentRetirement {
  PreviewPairDigestSchema.parse(options.profileFingerprint);
  const resource = previewPairCloudResource(options.project, options.region, options.service);
  const parent = `projects/${options.project}/locations/${options.region}`;
  const retire = createPreviewPairCloudRetirement(options);
  function operationName(value: string) {
    const suffix = value.slice(`${parent}/operations/`.length);
    if (!value.startsWith(`${parent}/operations/`) || !/^[A-Za-z0-9._~-]{1,128}$/.test(suffix) || [".", ".."].includes(suffix)) {
      throw new PreviewPairConflictError();
    }
    return value;
  }
  function belongs(raw: unknown, row: PreviewPairIntentRow) {
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
  return async (expected, claim, signal) => {
    const canonical = () => withPreviewPairIntentClaim(options.db, claim, options.now(), async (_trx, row) => {
      if (row.state !== "cleanup_pending" || row.profile_fingerprint !== options.profileFingerprint
        || row.pair_id !== expected.pair_id || row.generation !== expected.generation || row.source_sha !== expected.source_sha
        || row.controller_run_id !== expected.controller_run_id || row.publication_id !== expected.publication_id) throw new PreviewPairConflictError();
      return row;
    });
    const row = await canonical(); signal.throwIfAborted();
    // The source publisher must claim before issuing its single cloud mutation.
    // Pending/stopped intents cannot claim: an unissued request has no side effect.
    if (row.publication_state === "unissued") return true;
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
    if (row.publication_state === "issuing") {
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
      if (!found) return false; // Unknown outcome remains visible and holds capacity.
      const name = found.name;
      await withPreviewPairIntentClaim(options.db, claim, options.now(), async (trx, current) => {
        if (current.state !== "cleanup_pending" || current.publication_state !== "issuing"
          || current.publication_id !== row.publication_id || current.profile_fingerprint !== options.profileFingerprint) throw new PreviewPairConflictError();
        await trx.executor.updateTable("preview_pair_cloud_intents").set({ publication_state: "accepted", operation_name: name,
          revision: sql`revision + 1`, claim_id: null, claim_expires_at: null, next_attempt_at: new Date(options.now()).toISOString() })
          .where("pair_id", "=", claim.pairId).where("generation", "=", claim.generation).where("revision", "=", claim.revision)
          .where("claim_id", "=", claim.claimId).where("publication_state", "=", "issuing").returning("pair_id").executeTakeFirstOrThrow();
      });
      return false; // Resume under a fresh claim after recovering the receipt.
    }
    if (row.publication_state === "accepted") {
      const name = operationName(z.string().parse(row.operation_name)), response = await get(name, "publication_operation");
      if (response.status === 404) { await response.body?.cancel(); return false; }
      const operation = Operation.parse(await readPreviewPairJson(response, 256 * 1024));
      if (operation.name !== name || operation.done !== true) return false;
    }
    await canonical();
    return retire(async () => {
      const fresh = await canonical();
      return { pairId: fresh.pair_id, generation: fresh.generation, sourceSha: fresh.source_sha };
    }, deadline);
  };
}
