import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { previewPairProvenanceFixture } from "./preview-pair-provenance-fixture.js";
import { createPreviewPairGitHub } from "../../packages/platform/src/preview-pair/github.js";
import { createPreviewPairSourceAuthority, PREVIEW_PAIR_REQUEST_LABEL } from "../../packages/platform/src/preview-pair/source-authority.js";
import { preparePreviewPairCloudIntent } from "../../packages/platform/src/preview-pair/cloud-intents.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { requestPreviewPairUpdate } from "../../packages/platform/src/preview-pair/update.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("source readers bind live proof to the full canonical generation", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { f = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  async function setup() {
    const p = previewPairProvenanceFixture(), proof = p.authority;
    const pull = { number: f.pair.pr, state: "open", labels: [{ name: PREVIEW_PAIR_REQUEST_LABEL }],
      head: { sha: f.pair.source_sha, repo: { full_name: "HamedMP/matrix-os" } }, base: { repo: { full_name: "HamedMP/matrix-os" } } };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(pull));
    const cloud = vi.fn(async () => proof);
    const authority = createPreviewPairSourceAuthority({ db: f.db, config: f.config, cloud,
      github: createPreviewPairGitHub({ token: "fixture-github-token", reviewedControllerSha: f.config.reviewedControllerSha, fetchImpl }),
      controlClerkSecret: "sk_test_control_fixture", identity: { controlIssuer: "https://control.clerk.accounts.dev",
        previewIssuer: f.config.identityIssuer, isMaintainer: async () => true, membership: async () => true, verifyFixtures: async () => true } });
    return { authority, proof, pull, cloud, fetchImpl };
  }
  it("accepts fresh proof only for the stored candidate and its full pair identity", async () => {
    const s = await setup();
    expect(await s.authority.authority(f.candidate, AbortSignal.timeout(5_000))).toBe(true);
    // The short public tag is the same; the canonical full UUID is different.
    s.proof.pairId = s.proof.pairId.slice(0, -1) + (s.proof.pairId.endsWith("1") ? "2" : "1");
    expect(await s.authority.authority(f.candidate, AbortSignal.timeout(5_000))).toBe(false);
    expect(await s.authority.authority({ ...f.candidate, sourceSha: "f".repeat(40) }, AbortSignal.timeout(5_000))).toBe(false);
    s.proof.pairId = f.pair.pair_id;
    const sourceProfileFingerprint = "a".repeat(64), candidate = { ...f.candidate, sourceProfileFingerprint };
    f.config.sourceProfileFingerprint = sourceProfileFingerprint;
    await f.db.executor.updateTable("preview_pair_generations").set({ candidate: JSON.stringify(candidate) }).execute();
    expect(await s.authority.authority(candidate, AbortSignal.timeout(5_000))).toBe(true);
    const calls = s.cloud.mock.calls.length;
    f.config.sourceProfileFingerprint = "b".repeat(64);
    expect(await s.authority.authority(candidate, AbortSignal.timeout(5_000))).toBe(false);
    expect(s.cloud).toHaveBeenCalledTimes(calls);

  });
  it("distinguishes close/removal from an unavailable request lookup", async () => {
    const s = await setup(), input = { pairId: f.pair.pair_id, generation: 1, pr: f.pair.pr };
    expect(await s.authority.inspectRequest(input, AbortSignal.timeout(5_000))).toEqual({ open: true, requested: true, sourceSha: f.pair.source_sha });
    s.pull.labels = []; expect(await s.authority.inspectRequest(input, AbortSignal.timeout(5_000))).toMatchObject({ open: true, requested: false });
    s.pull.state = "closed"; expect(await s.authority.inspectRequest(input, AbortSignal.timeout(5_000))).toMatchObject({ open: false });
    s.fetchImpl.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(s.authority.inspectRequest(input, AbortSignal.timeout(5_000))).rejects.toThrow("unavailable");
  });
  it("retires an unadopted request when its reviewed controller exits, even successfully", async () => {
    const s = await setup(), pairId = "44444444-4444-4444-8444-444444444444";
    const config = { ...f.config, sourceProfileFingerprint: "f".repeat(64) };
    await preparePreviewPairCloudIntent(f.db, config, { pairId, generation: 1, pr: 3023, requesterId: "user_requester",
      sourceSha: f.pair.source_sha, controllerRunId: 42, profileFingerprint: config.sourceProfileFingerprint }, PAIR_NOW);
    s.pull.number = 3023;
    const run = { id: 42, run_attempt: 1, event: "workflow_dispatch", status: "completed", conclusion: "success" as string | null,
      head_sha: f.config.reviewedControllerSha, path: ".github/workflows/preview-collaboration-pair.yml",
      repository: { full_name: "HamedMP/matrix-os" }, head_repository: { full_name: "HamedMP/matrix-os" } };
    s.fetchImpl.mockImplementation(async target => Response.json(new URL(String(target)).pathname.endsWith("/42/attempts/1") ? run : s.pull));
    expect(await s.authority.inspectRequest({ pairId, generation: 1, pr: 3023 }, AbortSignal.timeout(5000)))
      .toMatchObject({ requested: false, sourceSha: f.pair.source_sha });
  });
  it("keeps a successfully adopted controller but retires failed or cancelled canonical generations", async () => {
    const s = await setup(), input = { pairId: f.pair.pair_id, generation: 1, pr: f.pair.pr };
    await f.db.executor.updateTable("preview_pair_generations").set({ controller_run_id: "42" }).execute();
    const run = { id: 42, run_attempt: 1, event: "workflow_dispatch", status: "completed", conclusion: "success" as string | null,
      head_sha: f.config.reviewedControllerSha, path: ".github/workflows/preview-collaboration-pair.yml",
      repository: { full_name: "HamedMP/matrix-os" }, head_repository: { full_name: "HamedMP/matrix-os" } };
    s.fetchImpl.mockImplementation(async target => Response.json(new URL(String(target)).pathname.endsWith("/42/attempts/1") ? run : s.pull));
    expect(await s.authority.inspectRequest(input, AbortSignal.timeout(5000))).toMatchObject({ requested: true });
    run.conclusion = "cancelled";
    expect(await s.authority.inspectRequest(input, AbortSignal.timeout(5000))).toMatchObject({ requested: false });
    run.head_sha = "e".repeat(40);
    await expect(s.authority.inspectRequest(input, AbortSignal.timeout(5000))).rejects.toThrow("unavailable");
    run.head_sha = f.config.reviewedControllerSha; run.conclusion = null;
    await expect(s.authority.inspectRequest(input, AbortSignal.timeout(5000))).rejects.toThrow("unavailable");
    s.pull.labels = [];
    expect(await s.authority.inspectRequest(input, AbortSignal.timeout(5000))).toMatchObject({ requested: false });
  });
  it("checks the target controller during an update rather than the previous successful run", async () => {
    const s = await setup();
    await f.db.executor.updateTable("preview_pair_generations").set({ controller_run_id: "40" }).execute();
    await requestPreviewPairUpdate(f.db, f.pair.pair_id, 1, f.pair.revision, { ...f.candidate,
      browserOrigin: f.candidate.browserOrigin.replace("g1", "g2"), apiOrigin: f.candidate.apiOrigin.replace("g1", "g2") }, PAIR_NOW, 42);
    const run = (id: number) => ({ id, run_attempt: 1, event: "workflow_dispatch", status: "completed", conclusion: id === 42 ? "cancelled" : "success",
      head_sha: f.config.reviewedControllerSha, path: ".github/workflows/preview-collaboration-pair.yml",
      repository: { full_name: "HamedMP/matrix-os" }, head_repository: { full_name: "HamedMP/matrix-os" } });
    s.fetchImpl.mockImplementation(async target => {
      const path = new URL(String(target)).pathname;
      return Response.json(path.includes("/actions/runs/") ? run(Number(path.split("/").at(-3))) : s.pull);
    });
    expect(await s.authority.inspectRequest({ pairId: f.pair.pair_id, generation: 1, pr: f.pair.pr }, AbortSignal.timeout(5000)))
      .toMatchObject({ requested: false });
    expect(s.fetchImpl.mock.calls.some(([target]) => String(target).endsWith("/actions/runs/42/attempts/1"))).toBe(true);
  });
});
