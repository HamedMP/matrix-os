import { z } from "zod/v4";
import { sql, type Selectable } from "kysely";
import { PreviewPairActorSchema, PreviewPairIdSchema, PreviewPairPrSchema, PreviewPairShaSchema, PreviewPairGenerationSchema } from "@matrix-os/contracts/preview-pair";
import { PreviewPairActionSchema, PreviewPairListSchema, PreviewPairReconcileSchema, PreviewPairStartSchema } from "./api-contracts.js";
import { PreviewPairConflictError, readPreviewPair, recordPreviewPairCurrency } from "./repository.js";
import { admitPreviewPair } from "./admission.js";
import { verifyPreviewPairCandidate, type PreviewPairProvenanceSource } from "./provenance.js";
import { requestPreviewPairStop, claimPreviewPair } from "./lifecycle.js";
import { requestPreviewPairUpdate } from "./update.js";
import { refreshPreviewPairReadiness } from "./readiness.js";
import { readPreviewPairReport } from "./reports.js";
import { verifiedPreviewPairReader, authorizePreviewPairReader, PreviewPairAccessError, type PreviewPairReader, type PreviewPairMaintainerCheck } from "./readers.js";
import { createPreviewPairReconciler, type PreviewPairReconcilerDeps } from "./reconciler.js";
import { previewPairOperation } from "./operation.js";
import type { PreviewPairsTable } from "./types.js";

const Controller = z.strictObject({ runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), controllerSha: PreviewPairShaSchema,
  requesterId: PreviewPairActorSchema, pairId: PreviewPairIdSchema, pr: PreviewPairPrSchema,
  generation: PreviewPairGenerationSchema, sourceSha: PreviewPairShaSchema });
export interface PreviewPairServiceDeps extends PreviewPairReconcilerDeps {
  source: PreviewPairProvenanceSource;
  /** Authenticated reviewed-controller receipt, never an echo of HTTP input. */
  resolveController(input: { runId: number; pairId: string; pr: number; generation: number; sourceSha: string }, signal: AbortSignal): Promise<unknown>;
  isMaintainer: PreviewPairMaintainerCheck;
}
export function previewPairSummary(pair: Selectable<PreviewPairsTable>) {
  return { pairId: pair.pair_id, generation: pair.generation, revision: pair.revision, pr: pair.pr,
    sourceSha: pair.source_sha, state: pair.state, outdated: pair.outdated, expiresAt: pair.expires_at,
    reportPath: `/api/preview-pairs/${pair.pair_id}` };
}

export function createPreviewPairService(deps: PreviewPairServiceDeps) {
  const { db, config } = deps, now = deps.now ?? Date.now;
  const reconciler = createPreviewPairReconciler(deps);
  const maintainer = (actor: string) => previewPairOperation(() => deps.isMaintainer(actor));
  async function controller(input: z.infer<typeof Controller> | Omit<z.infer<typeof Controller>, "requesterId" | "controllerSha">) {
    const raw = await previewPairOperation(signal => deps.resolveController(input, signal));
    const proof = Controller.safeParse(raw);
    if (!proof.success || proof.data.runId !== input.runId || proof.data.controllerSha !== config.reviewedControllerSha
      || proof.data.pairId !== input.pairId || proof.data.pr !== input.pr || proof.data.generation !== input.generation
      || proof.data.sourceSha !== input.sourceSha || !await maintainer(proof.data.requesterId)) throw new PreviewPairAccessError(403);
    return proof.data.requesterId;
  }
  return {
    async start(raw: unknown) {
      const input = PreviewPairStartSchema.parse(raw);
      const requesterId = await controller({ runId: input.controllerRunId, pairId: input.pairId,
        pr: input.pr, generation: 1, sourceSha: input.sourceSha });
      if (!await previewPairOperation(signal => deps.verifyFixtures(signal))) throw new PreviewPairAccessError(503);
      const candidate = await verifyPreviewPairCandidate(input.candidate, { pairId: input.pairId, generation: 1,
        pr: input.pr, sourceSha: input.sourceSha }, deps.source, config, now());
      const pair = await admitPreviewPair(db, config, { pairId: input.pairId, pr: input.pr,
        requesterId, sourceSha: input.sourceSha, candidate }, deps.prepare, now());
      // The workflow may only cancel its own generated request; reuse never grants a new run ownership.
      return { ...previewPairSummary(pair), ownedRequest: pair.pair_id === input.pairId };
    },
    async action(pairId: string, raw: unknown) {
      PreviewPairIdSchema.parse(pairId); const input = PreviewPairActionSchema.parse(raw);
      const pair = await readPreviewPair(db, pairId);
      if (!pair || pair.generation !== input.generation) throw new PreviewPairConflictError();
      if (input.type === "stop") return previewPairSummary(await requestPreviewPairStop(db, pairId, input.generation, input.revision, now()));
      if (pair.revision !== input.revision) throw new PreviewPairConflictError();
      if (input.type === "reconcile") return previewPairSummary(await reconciler.run(pairId, input.generation, input.revision));
      await controller({ runId: input.controllerRunId, pairId, pr: pair.pr, generation: input.generation + 1, sourceSha: input.candidate.sourceSha });
      if (!await previewPairOperation(signal => deps.verifyFixtures(signal))) throw new PreviewPairAccessError(503);
      const candidate = await verifyPreviewPairCandidate(input.candidate, { pairId, generation: input.generation + 1,
        pr: pair.pr, sourceSha: input.candidate.sourceSha }, deps.source, config, now());
      return previewPairSummary(await requestPreviewPairUpdate(db, pairId, input.generation, input.revision, candidate, now()));
    },
    async report(pairId: string, reader: PreviewPairReader) {
      return readPreviewPairReport(db, pairId, reader, maintainer, now());
    },
    async manifest(pairId: string, reader: PreviewPairReader) {
      let pair = await authorizePreviewPairReader(db, pairId, reader, maintainer, now());
      if (pair.state !== "ready" || Date.parse(pair.expires_at) <= now()) throw new PreviewPairAccessError(503);
      const request = z.strictObject({ open: z.boolean(), requested: z.boolean(), sourceSha: PreviewPairShaSchema })
        .parse(await previewPairOperation(signal => deps.inspectRequest({ pairId, pr: pair.pr, generation: pair.generation }, signal)));
      if (!request.open || !request.requested) {
        await requestPreviewPairStop(db, pairId, pair.generation, pair.revision, now()); throw new PreviewPairAccessError(503);
      }
      pair = await recordPreviewPairCurrency(db, pair, request.sourceSha);
      const claim = await claimPreviewPair(db, pairId, pair.generation, pair.revision, now());
      return refreshPreviewPairReadiness(db, claim, config, deps.readiness, now);
    },
    async list(raw: unknown, rawReader: PreviewPairReader) {
      const reader = verifiedPreviewPairReader(rawReader, now()), query = PreviewPairListSchema.parse(raw);
      if (reader.kind !== "control" || !await maintainer(reader.actorId)) throw new PreviewPairAccessError(403);
      let select = db.executor.selectFrom("preview_pairs").select("pair_id").orderBy("pair_id").limit(query.limit + 1);
      if (query.cursor) select = select.where("pair_id", ">", query.cursor);
      const rows = await select.execute(), page = rows.slice(0, query.limit);
      const items = await Promise.all(page.map(row => readPreviewPairReport(db, row.pair_id, reader, async () => true, now())));
      return { items, cursor: rows.length > query.limit ? page.at(-1)!.pair_id : null };
    },
    async reconcile(raw: unknown) {
      const { limit } = PreviewPairReconcileSchema.parse(raw), started = performance.now();
      const rows = await db.executor.selectFrom("preview_pairs").select(["pair_id", "generation", "revision"])
        .where("state", "!=", "stopped").where(eb => eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", new Date(now()).toISOString())]))
        .orderBy(sql`CASE WHEN state = 'cleanup_pending' THEN 0 WHEN state = 'updating' THEN 1 WHEN state = 'queued' THEN 2 ELSE 3 END`)
        .orderBy("created_at").orderBy("pair_id").limit(limit).execute();
      let checked = 0, failed = 0;
      for (const pair of rows) {
        // Reserve the rest of the minute for one worst-case bounded external stage.
        if (checked && performance.now() - started > 5_000) break;
        checked += 1;
        try { await reconciler.run(pair.pair_id, pair.generation, pair.revision); }
        catch (error: unknown) { failed += 1; console.warn("[preview-pair] reconcile deferred", error instanceof Error ? error.name : "UnknownError"); }
      }
      return { checked, failed };
    },
  };
}
