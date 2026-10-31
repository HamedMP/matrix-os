import { z } from "zod/v4";
import { PreviewPairIdSchema, PreviewPairGenerationSchema, PreviewPairPrSchema, PreviewPairShaSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import { PreviewPairFailureStageSchema } from "./api-contracts.js";
import { verifiedPreviewPairReader, PreviewPairAccessError, type PreviewPairReader, type PreviewPairMaintainerCheck } from "./readers.js";

const Timestamp = z.iso.datetime({ offset: true });
export const PreviewPairRequestReportSchema = z.strictObject({ kind: z.literal("request"),
  pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema, revision: z.number().int().positive(),
  pr: PreviewPairPrSchema, sourceSha: PreviewPairShaSchema,
  state: z.enum(["prepared", "adopted", "cleanup_pending", "stopped"]),
  publication: z.enum(["unissued", "issuing", "accepted", "rejected"]), createdAt: Timestamp, expiresAt: Timestamp,
  infrastructureReady: z.literal(false), acceptance: z.literal("not_run"), members: z.array(z.never()).length(0),
  failedStage: z.union([PreviewPairFailureStageSchema, z.literal("unavailable")]).nullable(),
});

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
  const failure = PreviewPairFailureStageSchema.safeParse(row.failure_code);
  return PreviewPairRequestReportSchema.parse({ kind: "request", pairId, generation: row.generation, revision: row.revision,
    pr: row.pr, sourceSha: row.source_sha, state: row.state, publication: row.publication_state,
    createdAt: row.created_at, expiresAt: row.expires_at, infrastructureReady: false, acceptance: "not_run", members: [],
    failedStage: row.failure_code === null ? null : failure.success ? failure.data : "unavailable" });
}
