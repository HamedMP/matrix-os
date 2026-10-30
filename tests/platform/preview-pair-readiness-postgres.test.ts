import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { claimPreviewPair } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { refreshPreviewPairReadiness } from "../../packages/platform/src/preview-pair/readiness.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("canonical pair readiness keeps healthy infrastructure separate from product acceptance", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { fixture = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  async function setup(fault?: string) {
    await fixture.db.executor.updateTable("user_machines").set({ status: "running" }).execute();
    const rows = await fixture.db.executor.selectFrom("preview_pair_members").selectAll().execute();
    const adapters = {
      authority: async () => fault !== "isolation",
      membership: async (actor: string) => actor !== fixture.manifest.outsiderActorId && fault !== "membership",
      observe: async (member: { role: "owner" | "member"; machineId: string; actorId: string; handle: string }) => ({
        ...fixture.manifest.members[member.role], machineId: member.machineId, actorId: member.actorId,
        healthy: fault !== "offline", bundleSha256: fixture.candidate.hostBundleSha256,
        observedAt: new Date(PAIR_NOW).toISOString(),
        runningVersion: fault === "wrong running version" ? "different-version" : fixture.candidate.hostBundleVersion,
        runningSha: fault === "wrong source" ? "f".repeat(40) : fixture.candidate.sourceSha,
        lastControlAt: new Date(PAIR_NOW - (fault === "stale control" ? 120_000 : 5_000)).toISOString(),
        runtimeSlot: fault === "primary fallback" ? "primary" : member.handle,
      }),
      funding: async (member: { machineId: string; actorId: string; tokenEpoch: number }) => ({
        source: "preview-test", machineId: member.machineId, actorId: member.actorId, tokenEpoch: member.tokenEpoch,
        remainingMicrousd: fault === "funding" ? 0 : 1_000_000,
        expiresAt: fixture.manifest.fundingExpiresAt,
      }),
    };
    const claim = await claimPreviewPair(fixture.db, fixture.pair.pair_id, 1, 1, PAIR_NOW);
    return { rows, adapters, claim };
  }
  it("issues a live exact-source manifest only after both independent canonical observations pass", async () => {
    const { claim, adapters, rows } = await setup();
    const manifest = await refreshPreviewPairReadiness(fixture.db, claim, fixture.config, adapters, () => PAIR_NOW);
    expect(manifest.members.owner.machineId).toBe(rows.find(row => row.role === "owner")!.machine_id);
    expect(manifest.members.member.machineId).toBe(rows.find(row => row.role === "member")!.machine_id);
    expect(manifest.organizationId).toBe(fixture.manifest.organizationId);
    expect((await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow()).state).toBe("ready");
    // Readiness never publishes a product project or creates collaboration grants.
    expect(fixture.hetzner.createServer).not.toHaveBeenCalled();
  });
  it.each(["isolation", "membership", "offline", "wrong source", "wrong running version", "stale control", "primary fallback", "funding"])(
    "fails closed for %s without marking the pair ready", async fault => {
      const { claim, adapters } = await setup(fault);
      await expect(refreshPreviewPairReadiness(fixture.db, claim, fixture.config, adapters, () => PAIR_NOW)).rejects.toThrow("unavailable");
      const failed = await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow();
      expect(failed.state).not.toBe("ready");
      const expectedStage = { isolation: /^authority$/, membership: /^membership$/, offline: /^(owner|member)_runtime$/,
        "wrong source": /^(owner|member)_source$/, "wrong running version": /^(owner|member)_source$/, "stale control": /^(owner|member)_control$/,
        "primary fallback": /^(owner|member)_runtime$/, funding: /^(owner|member)_funding$/ }[fault]!;
      expect(failed.failure_code).toMatch(expectedStage);
    });
});
