import { PreviewPairIdSchema, PreviewPairGenerationSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import type { Selectable } from "kysely";
import type { PreviewPairCloudIntentsTable } from "./types.js";
import { PreviewPairFailureStageSchema } from "./api-contracts.js";
import { verifiedPreviewPairReader, PreviewPairAccessError, type PreviewPairReader, type PreviewPairMaintainerCheck } from "./readers.js";
import { PreviewPairRequestReportSchema } from "@matrix-os/contracts/preview-pair-control";
export { PreviewPairRequestReportSchema };

/** Diagnostic authority never confers a fixture, manifest, session or content
 * capability. A Preview-issuer actor cannot impersonate a control requester. */
export async function readPreviewPairRequestReport(db: PlatformDB, pairId: string, generation: number | undefined,
  rawReader: PreviewPairReader, isMaintainer: PreviewPairMaintainerCheck, now: number) {
  PreviewPairIdSchema.parse(pairId);
  if (generation !== undefined) PreviewPairGenerationSchema.parse(generation);
  const reader = verifiedPreviewPairReader(rawReader, now);
  await db.ready;
  let query = db.executor.selectFrom("preview_pair_cloud_intents").selectAll().where("pair_id", "=", pairId);
  if (generation !== undefined) query = query.where("generation", "=", generation);
  const row = await query.orderBy("generation", "desc").limit(1).executeTakeFirst();
  if (!row || reader.kind !== "control"
    || reader.actorId !== row.requester_id && !await isMaintainer(reader.actorId)) throw new PreviewPairAccessError(404);
  return previewPairRequestSummary(row);
}

/** Safe projection shared by independently authorized reader/operator paths. */
export function previewPairRequestSummary(row: Selectable<PreviewPairCloudIntentsTable>) {
  const failure = PreviewPairFailureStageSchema.safeParse(row.failure_code);
  return PreviewPairRequestReportSchema.parse({ kind: "request", pairId: row.pair_id, generation: row.generation, revision: row.revision,
    pr: row.pr, sourceSha: row.source_sha, state: row.state, publication: row.publication_state,
    createdAt: row.created_at, expiresAt: row.expires_at, infrastructureReady: false, acceptance: "not_run", members: [],
    failedStage: row.failure_code === null ? null : failure.success ? failure.data : "unavailable" });
}
