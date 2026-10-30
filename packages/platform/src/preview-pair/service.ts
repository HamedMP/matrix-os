import { z } from "zod/v4";
import { sql, type Selectable } from "kysely";
import { PreviewPairActorSchema, PreviewPairIdSchema, PreviewPairPrSchema, PreviewPairShaSchema, PreviewPairGenerationSchema } from "@matrix-os/contracts/preview-pair";
import { PreviewPairActionSchema, PreviewPairListSchema, PreviewPairReconcileSchema, PreviewPairStartSchema,
  PreviewPairPrepareRequestSchema, PreviewPairRequestStopSchema, PreviewPairPublishSchema } from "./api-contracts.js";
import { PreviewPairPublicationResultSchema, type PreviewPairPublisher } from "./publication-contract.js";
import { preparePreviewPairCloudIntent, stopPreviewPairCloudIntent } from "./cloud-intents.js";
import { createPreviewPairIntentRecovery, type PreviewPairIntentRetirement } from "./intent-recovery.js";
import { PreviewPairConflictError, readPreviewPair, recordPreviewPairCurrency } from "./repository.js";
import { admitPreviewPair } from "./admission.js";
import { verifyPreviewPairCandidate, type PreviewPairProvenanceSource } from "./provenance.js";
import { requestPreviewPairStop, claimPreviewPair } from "./lifecycle.js";
import { requestPreviewPairUpdate } from "./update.js";
import { refreshPreviewPairReadiness } from "./readiness.js";
import { readPreviewPairReport } from "./reports.js";
import { readPreviewPairRequestReport } from "./request-reports.js";
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
  retireCloudIntent?: PreviewPairIntentRetirement;
  publication?: PreviewPairPublisher;
}
export function previewPairSummary(pair: Selectable<PreviewPairsTable>) {
  return { pairId: pair.pair_id, generation: pair.generation, revision: pair.revision, pr: pair.pr,
    sourceSha: pair.source_sha, state: pair.state, outdated: pair.outdated, expiresAt: pair.expires_at,
    reportPath: `/api/preview-pairs/${pair.pair_id}` };
}

export function createPreviewPairService(deps: PreviewPairServiceDeps) {
  const { db, config } = deps, now = deps.now ?? Date.now;
  const reconciler = createPreviewPairReconciler(deps);
  const recoverRequests = createPreviewPairIntentRecovery({ db, admissionEnabled: config.admissionEnabled, profileFingerprint: config.sourceProfileFingerprint,
    now, inspectRequest: deps.inspectRequest, retire: deps.retireCloudIntent });
  const maintainer = (actor: string) => previewPairOperation(() => deps.isMaintainer(actor));
  async function controller(input: z.infer<typeof Controller> | Omit<z.infer<typeof Controller>, "requesterId" | "controllerSha">) {
    const raw = await previewPairOperation(signal => deps.resolveController(input, signal));
    const proof = Controller.safeParse(raw);
    if (!proof.success || proof.data.runId !== input.runId || proof.data.controllerSha !== config.reviewedControllerSha
      || proof.data.pairId !== input.pairId || proof.data.pr !== input.pr || proof.data.generation !== input.generation
      || proof.data.sourceSha !== input.sourceSha || !await maintainer(proof.data.requesterId)) throw new PreviewPairAccessError(403);
    return proof.data.requesterId;
  }
  async function reconcilePairs(limit: number) {
    if (!limit) return { checked: 0, failed: 0 };
    const started = performance.now();
    const rows = await db.executor.selectFrom("preview_pairs").select(["pair_id", "generation", "revision"])
      .where("state", "!=", "stopped").where(eb => eb.or([
        eb.and([eb("state", "!=", "cleanup_pending"), eb("expires_at", "<=", new Date(now()).toISOString())]),
        eb.and([eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", new Date(now()).toISOString())]),
          eb.or([eb("claim_expires_at", "is", null), eb("claim_expires_at", "<=", new Date(now()).toISOString())])]),
      ]))
      .orderBy(sql`CASE WHEN state <> 'cleanup_pending' AND expires_at <= ${new Date(now()).toISOString()} THEN 0
        WHEN state = 'cleanup_pending' THEN 1 WHEN state = 'updating' THEN 2 WHEN state = 'queued' THEN 4 ELSE 3 END`)
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
  }
  return {
    async prepareRequest(raw: unknown) {
      if (!config.admissionEnabled || !config.sourceProfileFingerprint) throw new PreviewPairAccessError(503);
      const input = PreviewPairPrepareRequestSchema.parse(raw);
      const requesterId = await controller({ runId: input.controllerRunId, pairId: input.pairId,
        pr: input.pr, generation: input.generation, sourceSha: input.sourceSha });
      // Current membership and actual target isolation are required before a
      // trusted publisher binds test credentials to any unmerged code.
      if (!await previewPairOperation(signal => deps.verifyFixtures(signal))) throw new PreviewPairAccessError(503);
      const current = z.strictObject({ open: z.boolean(), requested: z.boolean(), sourceSha: PreviewPairShaSchema })
        .parse(await previewPairOperation(signal => deps.inspectRequest(input, signal)));
      if (!current.open || !current.requested || current.sourceSha !== input.sourceSha) throw new PreviewPairConflictError();
      const row = await preparePreviewPairCloudIntent(db, config, { pairId: input.pairId, generation: input.generation,
        pr: input.pr, requesterId, sourceSha: input.sourceSha, controllerRunId: input.controllerRunId,
        profileFingerprint: config.sourceProfileFingerprint }, now());
      return { pairId: row.pair_id, generation: row.generation, state: row.state, expiresAt: row.expires_at,
        profileFingerprint: row.profile_fingerprint, buildContext: deps.publication?.context };
    },
    async stopRequest(pairId: string, raw: unknown) {
      const input = PreviewPairRequestStopSchema.parse(raw);
      const row = await stopPreviewPairCloudIntent(db, pairId, input.generation, input.controllerRunId, now());
      return { pairId: row.pair_id, generation: row.generation, state: row.state, expiresAt: row.expires_at };
    },
    async publishRequest(pairId: string, raw: unknown) {
      if (!config.admissionEnabled || !config.sourceProfileFingerprint || !deps.publication) throw new PreviewPairAccessError(503);
      PreviewPairIdSchema.parse(pairId); const input = PreviewPairPublishSchema.parse(raw);
      const row = await db.executor.selectFrom("preview_pair_cloud_intents").selectAll().where("pair_id", "=", pairId)
        .where("generation", "=", input.generation).where("controller_run_id", "=", String(input.controllerRunId)).executeTakeFirst();
      if (!row || row.state !== "prepared" || Date.parse(row.expires_at) <= now()
        || row.profile_fingerprint !== config.sourceProfileFingerprint) throw new PreviewPairConflictError();
      const requesterId = await controller({ runId: input.controllerRunId, pairId, generation: input.generation, pr: row.pr, sourceSha: row.source_sha });
      if (requesterId !== row.requester_id) throw new PreviewPairAccessError(403);
      if (!await previewPairOperation(signal => deps.verifyFixtures(signal))) throw new PreviewPairAccessError(503);
      const current = z.strictObject({ open: z.boolean(), requested: z.boolean(), sourceSha: PreviewPairShaSchema })
        .parse(await previewPairOperation(signal => deps.inspectRequest({ pairId, generation: input.generation, pr: row.pr }, signal)));
      if (!current.open || !current.requested || current.sourceSha !== row.source_sha) throw new PreviewPairConflictError();
      const result = PreviewPairPublicationResultSchema.safeParse(await previewPairOperation(signal => deps.publication!.publish({
        pairId, generation: input.generation, pr: row.pr, requesterId, sourceSha: row.source_sha, controllerRunId: input.controllerRunId,
        profileFingerprint: row.profile_fingerprint, imageSha256: input.imageSha256 }, signal)));
      if (!result.success) throw new PreviewPairAccessError(503);
      return result.data;
    },
    async start(raw: unknown) {
      if (!config.admissionEnabled) throw new PreviewPairAccessError(503);
      const input = PreviewPairStartSchema.parse(raw);
      const requesterId = await controller({ runId: input.controllerRunId, pairId: input.pairId,
        pr: input.pr, generation: 1, sourceSha: input.sourceSha });
      if (!await previewPairOperation(signal => deps.verifyFixtures(signal))) throw new PreviewPairAccessError(503);
      if (config.sourceProfileFingerprint && (!deps.publication || !await previewPairOperation(signal => deps.publication!.ready({
        pairId: input.pairId, generation: 1, pr: input.pr, requesterId, sourceSha: input.sourceSha,
        controllerRunId: input.controllerRunId, profileFingerprint: config.sourceProfileFingerprint! }, signal)))) throw new PreviewPairAccessError(503);
      const candidate = await verifyPreviewPairCandidate(input.candidate, { pairId: input.pairId, generation: 1,
        pr: input.pr, sourceSha: input.sourceSha }, deps.source, config, now());
      const pair = await admitPreviewPair(db, config, { pairId: input.pairId, pr: input.pr,
        requesterId, sourceSha: input.sourceSha, candidate, controllerRunId: input.controllerRunId }, deps.prepare, now());
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
      if (!config.admissionEnabled) throw new PreviewPairAccessError(503);
      const requesterId = await controller({ runId: input.controllerRunId, pairId, pr: pair.pr, generation: input.generation + 1, sourceSha: input.candidate.sourceSha });
      if (!await previewPairOperation(signal => deps.verifyFixtures(signal))) throw new PreviewPairAccessError(503);
      if (config.sourceProfileFingerprint && (!deps.publication || !await previewPairOperation(signal => deps.publication!.ready({
        pairId, generation: input.generation + 1, pr: pair.pr, requesterId, sourceSha: input.candidate.sourceSha,
        controllerRunId: input.controllerRunId, profileFingerprint: config.sourceProfileFingerprint! }, signal)))) throw new PreviewPairAccessError(503);
      const candidate = await verifyPreviewPairCandidate(input.candidate, { pairId, generation: input.generation + 1,
        pr: pair.pr, sourceSha: input.candidate.sourceSha }, deps.source, config, now());
      return previewPairSummary(await requestPreviewPairUpdate(db, pairId, input.generation, input.revision, candidate, now(), input.controllerRunId, requesterId));
    },
    async report(pairId: string, reader: PreviewPairReader) {
      // Choose by canonical existence, not by catching an authorization failure.
      // An unauthorized pair read must never fall through to another resource.
      if (!await readPreviewPair(db, pairId)) return readPreviewPairRequestReport(db, pairId, undefined, reader, maintainer, now());
      return readPreviewPairReport(db, pairId, reader, maintainer, now());
    },
    async requestReport(pairId: string, generation: number, reader: PreviewPairReader) {
      return readPreviewPairRequestReport(db, pairId, generation, reader, maintainer, now());
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
      const { limit } = PreviewPairReconcileSchema.parse(raw), requestBudget = Math.max(1, Math.floor(limit / 2));
      // Independent claims share one managed pass. Await both even if one query
      // fails, so shutdown cannot destroy the database under the other task.
      const results = await Promise.allSettled([recoverRequests(requestBudget), reconcilePairs(limit - requestBudget)]);
      let checked = 0, failed = 0;
      for (const result of results) {
        if (result.status === "fulfilled") { checked += result.value.checked; failed += result.value.failed; }
        else {
          failed++;
          console.warn("[preview-pair] reconciliation pass deferred", result.reason instanceof Error ? result.reason.name : "UnknownError");
        }
      }
      if (limit === 1 && results[0]!.status === "fulfilled" && results[0]!.value.checked === 0) return reconcilePairs(1);
      return { checked, failed };
    },
  };
}
