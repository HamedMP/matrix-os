import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { preparePreviewPairCloudIntent, stopPreviewPairCloudIntent } from "../../packages/platform/src/preview-pair/cloud-intents.js";
import { beginPreviewPairPublication, recordPreviewPairPublication } from "../../packages/platform/src/preview-pair/publication-journal.js";
import { requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("source publication journal preserves the effect fence", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { f = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  async function setup(generation = 1) {
    const config = { ...f.config, sourceProfileFingerprint: "f".repeat(64) };
    const input = { pairId: generation === 1 ? "44444444-4444-4444-8444-444444444444" : f.pair.pair_id,
      generation, pr: generation === 1 ? 3023 : f.pair.pr, requesterId: "user_requester", sourceSha: f.pair.source_sha,
      controllerRunId: 42, profileFingerprint: config.sourceProfileFingerprint };
    const intent = await preparePreviewPairCloudIntent(f.db, config, input, PAIR_NOW);
    const publication = { ...input, imageSha256: "e".repeat(64) };
    const saved = () => f.db.executor.selectFrom("preview_pair_cloud_intents").selectAll()
      .where("pair_id", "=", input.pairId).where("generation", "=", generation).executeTakeFirstOrThrow();
    return { config, input, intent, publication, saved };
  }
  it("concurrent requests grant exactly one effect and persist its digest before it can run", async () => {
    const s = await setup();
    const results = await Promise.all([beginPreviewPairPublication(f.db, s.config, s.publication, PAIR_NOW),
      beginPreviewPairPublication(f.db, s.config, s.publication, PAIR_NOW)]);
    expect(results.filter(result => result.issue)).toHaveLength(1);
    const saved = await s.saved();
    expect(saved).toMatchObject({ publication_state: "issuing", image_sha256: s.publication.imageSha256 });
    expect(saved.publication_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(results.every(result => result.row.publication_id === saved.publication_id)).toBe(true);
  });
  it("a different image cannot reuse a reserved publication identity", async () => {
    const s = await setup(); await beginPreviewPairPublication(f.db, s.config, s.publication, PAIR_NOW);
    await expect(beginPreviewPairPublication(f.db, s.config, { ...s.publication, imageSha256: "d".repeat(64) }, PAIR_NOW)).rejects.toThrow("unavailable");
    expect((await s.saved()).image_sha256).toBe(s.publication.imageSha256);
  });
  it("cancellation before issuance cannot reserve an effect", async () => {
    const s = await setup(); await stopPreviewPairCloudIntent(f.db, s.input.pairId, 1, 42, PAIR_NOW);
    await expect(beginPreviewPairPublication(f.db, s.config, s.publication, PAIR_NOW)).rejects.toThrow("unavailable");
    expect(await s.saved()).toMatchObject({ publication_state: "unissued", publication_id: null, image_sha256: null });
  });
  it("a late response is recorded after cancellation without reopening the request", async () => {
    const s = await setup(), begun = await beginPreviewPairPublication(f.db, s.config, s.publication, PAIR_NOW);
    await stopPreviewPairCloudIntent(f.db, s.input.pairId, 1, 42, PAIR_NOW);
    const result = { operationName: "projects/pair-test/locations/test/operations/publication" };
    await recordPreviewPairPublication(f.db, s.publication, begun.row.publication_id!, result, PAIR_NOW);
    const saved = await s.saved();
    expect(saved).toMatchObject({ state: "cleanup_pending", publication_state: "accepted", operation_name: result.operationName,
      claim_id: null, claim_expires_at: null });
    expect(await recordPreviewPairPublication(f.db, s.publication, begun.row.publication_id!, result, PAIR_NOW)).toEqual(saved);
  });
  it("a failed transaction rolls back both the nonce and image selection", async () => {
    const s = await setup();
    await expect(f.db.transaction(async () => {
      await beginPreviewPairPublication(f.db, s.config, s.publication, PAIR_NOW);
      throw new Error("simulated transaction rollback");
    })).rejects.toThrow("simulated transaction rollback");
    expect(await s.saved()).toMatchObject({ publication_state: "unissued", publication_id: null, image_sha256: null });
  });
  it("an expired request cannot reserve an effect", async () => {
    const s = await setup();
    await expect(beginPreviewPairPublication(f.db, s.config, s.publication, Date.parse(s.intent.expires_at))).rejects.toThrow("unavailable");
    expect((await s.saved()).publication_state).toBe("unissued");
  });
  it("a stopped parent generation cannot publish its unadopted update", async () => {
    const s = await setup(2);
    await requestPreviewPairStop(f.db, f.pair.pair_id, 1, f.pair.revision, PAIR_NOW);
    await expect(beginPreviewPairPublication(f.db, s.config, s.publication, PAIR_NOW)).rejects.toThrow("unavailable");
    expect((await s.saved()).publication_state).toBe("unissued");
    expect((await f.db.executor.selectFrom("preview_pair_fixtures").select("active_pair_id").executeTakeFirstOrThrow()).active_pair_id).toBe(f.pair.pair_id);
  });
});
