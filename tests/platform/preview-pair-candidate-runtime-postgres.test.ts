import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../packages/platform/src/main.js";
import { shutdownPlatformApp } from "../../packages/platform/src/shutdown-platform-app.js";
import { openProvisioningPayload } from "../../packages/platform/src/customer-vps-provisioning-jobs.js";
import { createPreviewPairRuntimeOnlyService } from "../../packages/platform/src/preview-pair/candidate-runtime.js";
import { createProjectedPreviewPair } from "./preview-pair-projected-postgres.js";
import { candidateRuntimeEnvironment } from "./preview-pair-candidate-env.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { stubOrchestrator } from "./proxy-routing-test-utils.js";
import { startCandidateProcess } from "./preview-pair-candidate-process.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("candidate registration without provider authority", () => {
  let f: Awaited<ReturnType<typeof createProjectedPreviewPair>>;
  beforeEach(async () => { f = await createProjectedPreviewPair(undefined, undefined, { register: false }); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  function service() {
    const env = { ...candidateRuntimeEnvironment(), PLATFORM_SECRET: f.previewSecret };
    const value = createPreviewPairRuntimeOnlyService({ db: f.target.db, env, now: () => new Date(PAIR_NOW) });
    return { value, env };
  }
  it("boots the real Platform entrypoint and registers over HTTP while paid provisioning is disabled", async () => {
    const env = { ...candidateRuntimeEnvironment(), PLATFORM_SECRET: f.previewSecret, PLATFORM_DATABASE_URL: f.target.databaseUrl };
    await f.target.db.executor.updateTable("user_machines").set({ registration_token_expires_at: new Date(Date.now() + 60_000).toISOString() })
      .where("machine_id", "=", f.owner.machine_id).execute();
    const process = await startCandidateProcess(env);
    try {
      const job = await f.source.db.executor.selectFrom("provisioning_jobs").select("encrypted_payload").where("machine_id", "=", f.owner.machine_id).executeTakeFirstOrThrow();
      const token = openProvisioningPayload(job.encrypted_payload!, f.controlSecret).registrationToken;
      const response = await fetch(`${process.origin}/vps/register`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", host: new URL(env.PLATFORM_PUBLIC_URL!).hostname },
        body: JSON.stringify({ machineId: f.owner.machine_id, hetznerServerId: 1001, publicIPv4: "203.0.113.11",
          imageVersion: f.source.candidate.hostBundleVersion, bundleSha256: f.source.candidate.hostBundleSha256, healthy: true }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ registered: true, status: "running" });
    } finally { expect(await process.stop()).toBe(0); }
  }, 45_000);
  it("mounts the existing registration route with a real bootstrap token and no provider credentials", async () => {
    const s = service();
    const app = createApp({ db: f.target.db, orchestrator: stubOrchestrator(), platformSecret: s.env.PLATFORM_SECRET,
      customerVpsService: s.value, env: s.env });
    try {
      const job = await f.source.db.executor.selectFrom("provisioning_jobs").select("encrypted_payload").where("machine_id", "=", f.owner.machine_id).executeTakeFirstOrThrow();
      const token = openProvisioningPayload(job.encrypted_payload!, f.controlSecret).registrationToken;
      const response = await app.request(`${f.source.candidate.apiOrigin}/vps/register`, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({
          machineId: f.owner.machine_id, hetznerServerId: 1001, publicIPv4: "203.0.113.11",
          imageVersion: f.source.candidate.hostBundleVersion, bundleSha256: f.source.candidate.hostBundleSha256, healthy: true,
        }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ registered: true, status: "running" });
      expect((await f.target.db.executor.selectFrom("user_machines").select("status").where("machine_id", "=", f.owner.machine_id).executeTakeFirstOrThrow()).status).toBe("running");
      expect(s.env.HETZNER_API_TOKEN).toBeUndefined();
    } finally { await shutdownPlatformApp(app); }
  });
  it("denies paid lifecycle methods before any new machine/job write", async () => {
    const s = service(); expect(s.value).toBeDefined(); if (!s.value) throw new Error("Runtime-only service is required");
    const before = await f.target.db.executor.selectFrom("user_machines").select("machine_id").execute();
    for (const call of [
      () => s.value!.provision({ clerkUserId: "user_outsider", handle: "outside", runtimeSlot: "primary" }),
      () => s.value!.provisionPreview({ clerkUserId: "user_outsider", handle: "pr-1", runtimeSlot: "pr-1", accessClerkUserIds: [] }),
      () => s.value!.delete(f.owner.machine_id), () => s.value!.deploy(),
      () => s.value!.dispatchProvisioningJobs(), () => s.value!.reconcileProvisioning(),
      () => s.value!.activateSpeech(), () => s.value!.suspendForBilling(f.owner.machine_id),
      () => s.value!.resumeForBilling(f.owner.machine_id),
    ]) await expect(call()).rejects.toMatchObject({ status: 503 });
    expect(await f.target.db.executor.selectFrom("user_machines").select("machine_id").execute()).toEqual(before);
    expect(await f.target.db.executor.selectFrom("provisioning_jobs").selectAll().execute()).toEqual([]);
  });
  it("cannot inspect a different pair generation through its administrative status method", async () => {
    const s = service(); expect(s.value).toBeDefined(); if (!s.value) throw new Error("Runtime-only service is required");
    await f.target.db.executor.updateTable("user_machines").set({ runtime_slot: "primary" }).where("machine_id", "=", f.owner.machine_id).execute();
    await expect(s.value.status(f.owner.machine_id)).rejects.toMatchObject({ status: 404 });
  });
});
