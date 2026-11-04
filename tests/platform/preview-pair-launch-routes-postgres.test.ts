import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { readyPreviewPair, previewPairReadinessAdapters } from "./preview-pair-ready-postgres.js";
import { previewPairProvenanceFixture } from "./preview-pair-provenance-fixture.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { createPreviewPairService } from "../../packages/platform/src/preview-pair/service.js";
import { createPreviewPairRoutes } from "../../packages/platform/src/preview-pair/routes.js";
import { requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";
const secret = "s".repeat(40);
// Required by the real PostgreSQL collector; ordinary unit shards have no DB.
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("non-authorizing launch routes preserve actual Source ownership and revocation", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { f = await createSeededPreviewPair(); await readyPreviewPair(f); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  function setup() {
    const readiness = previewPairReadinessAdapters(f);
    const membership = vi.fn(readiness.membership), isMaintainer = vi.fn(async (actor: string) => actor === "user_requester");
    const service = createPreviewPairService({ db: f.db, config: f.config, source: previewPairProvenanceFixture().source, prepare: f.prepare,
      resolveController: async () => null, verifyFixtures: async () => true, isMaintainer,
      inspectRequest: async () => ({ open: true, requested: true, sourceSha: f.candidate.sourceSha }), now: () => PAIR_NOW,
      readiness: { ...readiness, membership }, cleanup: { retire: async () => undefined, proveAbsent: async () => { throw new Error("not used"); } } });
    const app = createPreviewPairRoutes({ enabled: true, operatorSecret: secret, service, now: () => PAIR_NOW,
      authenticateReader: async req => req.headers.get("authorization") === "Bearer real-reader-fixture"
        ? { kind: "control", actorId: "user_requester", expiresAt: PAIR_NOW + 60_000 } : null });
    const post = (path: string, input: unknown, token?: string) => app.request(path, { method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input) });
    const issue = (role: "owner" | "member" = "owner") => post(`/api/preview-pairs/${f.pair.pair_id}/launch`, { role, platform: "darwin", arch: "arm64" }, "real-reader-fixture");
    return { service, membership, post, issue, app };
  }
  it("issues through the real authenticated manifest then publicly verifies only a current non-authorizing descriptor", async () => {
    const s = setup();
    expect((await s.post(`/api/preview-pairs/${f.pair.pair_id}/launch`, { role: "owner", platform: "darwin", arch: "arm64" })).status).toBe(401);
    const issued = await s.issue(); expect(issued.status).toBe(200);
    const proof = await issued.json();
    const owner = await f.db.executor.selectFrom("preview_pair_members").select("machine_id").where("role", "=", "owner").executeTakeFirstOrThrow();
    expect(proof.context).toMatchObject({ actorId: f.manifest.members.owner.actorId, machineId: owner.machine_id });
    const verified = await s.post("/api/preview-pairs/launch/verify", proof);
    expect(verified.status).toBe(200); expect(await verified.json()).toEqual({ valid: true });
    expect(await f.db.executor.selectFrom("user_machines").select("machine_id").execute()).toHaveLength(2);
  });
  it.each(["owner", "member"] as const)("verifies %s control generation independently of the machine token epoch", async role => {
    const members = await f.db.executor.selectFrom("preview_pair_members").select(["role", "observation"]).execute();
    // Launch issuance refreshes readiness through these host observations.
    f.manifest.members.owner.authorityGeneration = 7;
    f.manifest.members.member.authorityGeneration = 9;
    const s = setup(), issued = await s.issue(role);
    expect(issued.status).toBe(200); const proof = await issued.json();
    expect(proof.context.authorityGeneration).toBe(role === "owner" ? 7 : 9);
    const machine = await f.db.executor.selectFrom("user_machines").select("runtime_token_epoch")
      .where("machine_id", "=", proof.context.machineId).executeTakeFirstOrThrow();
    expect(machine.runtime_token_epoch).toBe(1);
    expect((await s.post("/api/preview-pairs/launch/verify", proof)).status).toBe(200);
    const observed = members.find(member => member.role === role)!.observation;
    await f.db.executor.updateTable("preview_pair_members")
      .set({ observation: JSON.stringify({ ...observed, authorityGeneration: proof.context.authorityGeneration + 1 }) })
      .where("role", "=", role).execute();
    expect((await s.post("/api/preview-pairs/launch/verify", proof)).status).toBe(404);
    f.manifest.members[role].authorityGeneration = proof.context.authorityGeneration + 1;
    const renewed = await s.issue(role); expect(renewed.status).toBe(200);
    const renewedProof = await renewed.json();
    expect((await s.post("/api/preview-pairs/launch/verify", renewedProof)).status).toBe(200);
    // Token revocation is an independent boundary even when control generation matches.
    await f.db.executor.updateTable("user_machines").set({ runtime_token_epoch: 2 })
      .where("machine_id", "=", proof.context.machineId).execute();
    expect((await s.post("/api/preview-pairs/launch/verify", renewedProof)).status).toBe(404);
  });
  it("checks crypto and streaming limits before canonical membership reads", async () => {
    const s = setup(), issued = await s.issue(); expect(issued.status).toBe(200);
    const proof = await issued.json(); s.membership.mockClear();
    expect((await s.post("/api/preview-pairs/launch/verify", { ...proof, signature: "a".repeat(43) })).status).toBe(404);
    const large = await s.app.request("/api/preview-pairs/launch/verify", { method: "POST", headers: { "content-type": "application/json", "content-length": "1" }, body: JSON.stringify({ padding: "x".repeat(20_000) }) });
    expect(large.status).toBe(413); expect(s.membership).not.toHaveBeenCalled();
  });
  it.each(["source", "slot", "epoch"])("rejects current %s drift even while the pair still says ready", async fault => {
    const s = setup(), issued = await s.issue(); expect(issued.status).toBe(200); const proof = await issued.json();
    if (fault === "source") {
      const row = await f.db.executor.selectFrom("preview_pair_members").select("observation").where("role", "=", "owner").executeTakeFirstOrThrow();
      await f.db.executor.updateTable("preview_pair_members").set({ observation: JSON.stringify({ ...row.observation, runningSha: "b".repeat(40) }) }).where("role", "=", "owner").execute();
    } else await f.db.executor.updateTable("user_machines").set(fault === "slot" ? { runtime_slot: "primary" } : { runtime_token_epoch: proof.context.authorityGeneration + 1 }).where("machine_id", "=", proof.context.machineId).execute();
    expect((await s.post("/api/preview-pairs/launch/verify", proof)).status).toBe(404);
  });
  it("does not let a signed descriptor outlive a current membership or canonical stop", async () => {
    const s = setup(), issued = await s.issue(); expect(issued.status).toBe(200); const proof = await issued.json();
    s.membership.mockResolvedValue(false);
    expect((await s.post("/api/preview-pairs/launch/verify", proof)).status).toBe(404);
    s.membership.mockImplementation(previewPairReadinessAdapters(f).membership);
    const row = await f.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow();
    await requestPreviewPairStop(f.db, row.pair_id, row.generation, row.revision, PAIR_NOW);
    expect((await s.post("/api/preview-pairs/launch/verify", proof)).status).toBe(404);
  });
});
