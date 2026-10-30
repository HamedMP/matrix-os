import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { readPreviewPairReport } from "../../packages/platform/src/preview-pair/reports.js";
import { readyPreviewPair } from "./preview-pair-ready-postgres.js";
import { sql } from "kysely";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("reports project only canonical safe observations", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { fixture = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  const reader = { actorId: "user_requester", kind: "control" as const, expiresAt: PAIR_NOW + 3_600_000 };
  const maintainer = async () => false;
  it("does not equate allocated machines or a ready state flag with current readiness", async () => {
    await fixture.db.executor.updateTable("preview_pairs").set({ state: "ready" }).execute();
    const report = await readPreviewPairReport(fixture.db, fixture.pair.pair_id, reader, maintainer, PAIR_NOW);
    expect(report.infrastructureReady).toBe(false);
    expect(report.acceptance).toBe("not_run");
    expect(report.members).toHaveLength(2);
  });
  it("projects the actual readiness producer's persisted proof and stops advertising it after its freshness bound", async () => {
    await readyPreviewPair(fixture);
    const fresh = await readPreviewPairReport(fixture.db, fixture.pair.pair_id, reader, maintainer, PAIR_NOW);
    expect(fresh.infrastructureReady).toBe(true);
    expect(fresh.members.every(member => member.controlFresh && member.sourceMatches && member.fundingReady)).toBe(true);
    const stale = await readPreviewPairReport(fixture.db, fixture.pair.pair_id, reader, maintainer, PAIR_NOW + 31_000);
    expect(stale.infrastructureReady).toBe(false);
  });
  it("does not reuse funding proof after a runtime-token epoch changes", async () => {
    await readyPreviewPair(fixture);
    await fixture.db.executor.updateTable("user_machines").set({ runtime_token_epoch: sql`runtime_token_epoch + 1` }).execute();
    const report = await readPreviewPairReport(fixture.db, fixture.pair.pair_id, reader, maintainer, PAIR_NOW);
    expect(report.infrastructureReady).toBe(false);
    expect(report.members.every(member => !member.fundingReady)).toBe(true);
  });
  it("a current known failure overrides an earlier healthy proof", async () => {
    await readyPreviewPair(fixture);
    await fixture.db.executor.updateTable("preview_pairs").set({ failure_code: "owner_control" }).execute();
    expect((await readPreviewPairReport(fixture.db, fixture.pair.pair_id, reader, maintainer, PAIR_NOW)).infrastructureReady).toBe(false);
  });
  it("allowlists failure stages and excludes provider fields, raw observations and credentials", async () => {
    await fixture.db.executor.updateTable("preview_pairs").set({ failure_code: "postgres credential /private/path" }).execute();
    await fixture.db.executor.updateTable("preview_pair_members").set({ observation: JSON.stringify({ token: "do-not-expose", providerIp: "203.0.113.1" }) }).execute();
    const report = await readPreviewPairReport(fixture.db, fixture.pair.pair_id, reader, maintainer, PAIR_NOW);
    expect(report.failedStage).toBe("unavailable");
    expect(JSON.stringify(report)).not.toMatch(/postgres|credential|private\/path|do-not-expose|203\.0\.113/);
  });
  it("reports a known control failure without exposing upstream errors", async () => {
    await fixture.db.executor.updateTable("preview_pairs").set({ failure_code: "owner_control" }).execute();
    const report = await readPreviewPairReport(fixture.db, fixture.pair.pair_id, reader, maintainer, PAIR_NOW);
    expect(report.failedStage).toBe("owner_control");
    expect(report.infrastructureReady).toBe(false);
  });
  it("retains the real reader boundary rather than trusting an actor string", async () => {
    await expect(readPreviewPairReport(fixture.db, fixture.pair.pair_id,
      { ...reader, actorId: "user_pair_outsider", kind: "preview" }, maintainer, PAIR_NOW)).rejects.toMatchObject({ status: 404 });
  });
});
