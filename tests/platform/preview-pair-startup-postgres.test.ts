import { Agent } from "undici";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { createIsolatedPreviewPairDatabase } from "./preview-pair-isolated-postgres.js";
import { createPreviewPairSourceFixture } from "./preview-pair-source-fixture.js";
import { createTestConfig } from "./customer-vps-service-test-helper.js";
import { createMockCustomerVpsSystemStore } from "./customer-vps-fixtures.js";
import type { HetznerClient } from "../../packages/platform/src/customer-vps-hetzner.js";
import { createCustomerVpsContext } from "../../packages/platform/src/customer-vps-context.js";
import * as targetDatabase from "../../packages/platform/src/preview-pair/target-database.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { createConfiguredPreviewPairRuntime, type ConfiguredPreviewPairRuntime } from "../../packages/platform/src/preview-pair/startup.js";
import { loadPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";
import { loadPreviewPairSourceProfile, previewPairSourceFingerprint } from "../../packages/platform/src/preview-pair/source-profile.js";
import { preparePreviewPairCloudIntent, stopPreviewPairCloudIntent } from "../../packages/platform/src/preview-pair/cloud-intents.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("configured source runtime lifetime", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  let target: Awaited<ReturnType<typeof createIsolatedPreviewPairDatabase>>;
  let dispatcher: Agent, runtime: ConfiguredPreviewPairRuntime | undefined;
  beforeEach(async () => {
    f = await createSeededPreviewPair();
    try { target = await createIsolatedPreviewPairDatabase(); dispatcher = new Agent(); }
    catch (error: unknown) { await f.destroy(); throw error; }
  }, 30_000);
  afterEach(async () => { await runtime?.close(); await dispatcher?.close(); try { await target?.destroy(); } finally { await f?.destroy(); } });
  function options(databaseUrl = target.databaseUrl) {
    const fixture = createPreviewPairSourceFixture(databaseUrl), cleanup = vi.fn<(cleanup: () => Promise<void>) => void>();
    const context = createCustomerVpsContext({ db: f.db, config: createTestConfig({ platformSecret: fixture.env.PLATFORM_SECRET }),
      hetzner: f.hetzner, systemStore: createMockCustomerVpsSystemStore() });
    return { ...fixture, cleanup, options: { env: fixture.env, db: f.db, customerVps: context.deps, dispatcher, google: fixture.google,
      clerkAuth: createClerkAuth({ verifyToken: async () => { throw new Error("No live login fixture"); } }),
      objectStore: { getObject: vi.fn(async () => ({ body: null })), putObject: vi.fn(async () => ({})) },
      funding: { config: { enabled: false as const }, relayOrigin: "https://matrix-ai-relay-production-fixture.a.run.app" },
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })), registerCleanup: cleanup } };
  }
  it("leaves a dormant runtime without credentials, resources or cleanup registrations", async () => {
    const s = options();
    expect(await createConfiguredPreviewPairRuntime({ ...s.options, env: {} })).toBeUndefined();
    expect(s.google.secret).not.toHaveBeenCalled(); expect(s.cleanup).not.toHaveBeenCalled();
  });
  it("composes authenticated reporting while the test bank is disabled and owns only its target pool", async () => {
    const s = options(); runtime = await createConfiguredPreviewPairRuntime(s.options);
    expect(runtime).toBeDefined(); expect(s.cleanup).toHaveBeenCalledOnce();
    expect(await runtime!.routes.service!.report(f.pair.pair_id, { kind: "control", actorId: "user_requester", expiresAt: Date.now() + 60_000 }))
      .toMatchObject({ pairId: f.pair.pair_id, state: "preparing" });
    await runtime!.close(); await s.cleanup.mock.calls[0][0]();
    expect((await sql<{ n: number }>`SELECT 1 AS n`.execute(f.db.executor)).rows[0].n).toBe(1);
    expect((await sql<{ n: number }>`SELECT 1 AS n`.execute(target.db.executor)).rows[0].n).toBe(1);
  });
  it("drains a running pass before close and never restarts after stopping", async () => {
    const s = options(); runtime = await createConfiguredPreviewPairRuntime(s.options);
    if (!runtime?.routes.service) throw new Error("Configured runtime is required");
    let release!: () => void, closed = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const reconcile = vi.spyOn(runtime.routes.service, "reconcile").mockImplementation(async () => { await pending; return { checked: 0, failed: 0 }; });
    try {
      runtime.start(); runtime.start(); await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
      const closing = runtime.close().then(() => { closed = true; });
      await Promise.resolve(); expect(closed).toBe(false);
      release(); await closing; expect(closed).toBe(true);
      runtime.start(); expect(reconcile).toHaveBeenCalledOnce();
    } finally { release(); await runtime.close(); }
  });
  it("closes its real target connection if startup cleanup registration fails", async () => {
    const s = options(), original = targetDatabase.createPreviewPairTargetDatabase;
    let opened: ReturnType<typeof original> | undefined;
    const factory = vi.spyOn(targetDatabase, "createPreviewPairTargetDatabase").mockImplementation(url => {
      opened = original(url); return opened;
    });
    const marker = new Error("intentional cleanup registration failure");
    try {
      await expect(createConfiguredPreviewPairRuntime({ ...s.options, registerCleanup: () => { throw marker; } })).rejects.toBe(marker);
      if (!opened) throw new Error("Real target connection was not constructed");
      await expect(sql`SELECT 1`.execute(opened.executor)).rejects.toThrow();
      expect((await sql<{ n: number }>`SELECT 1 AS n`.execute(target.db.executor)).rows[0].n).toBe(1);
    } finally { factory.mockRestore(); await opened?.destroy(); }
  });
  it("retires the owned provider server during a target outage but retains the unconfirmed lease", async () => {
    const url = new URL(target.databaseUrl); url.port = "1";
    const s = options(url.toString());
    const owner = await f.db.executor.selectFrom("preview_pair_members").selectAll().where("role", "=", "owner").executeTakeFirstOrThrow();
    const server = { id: 801, status: "running", labels: { app: "matrix-os", machine_id: owner.machine_id,
      clerk_user_id: owner.actor_id, runtime_slot: owner.handle } };
    let present = true;
    const provider = { ...f.hetzner, withSignal: (): HetznerClient => provider,
      inspectServersByLabel: vi.fn(async (selector: string) => ({ complete: true,
        servers: present && selector === `machine_id=${owner.machine_id}` ? [server] : [] })),
      getServer: vi.fn(async (id: number) => present && id === server.id ? server : null),
      deleteServer: vi.fn(async () => { present = false; }) };
    s.options.customerVps.hetzner = provider;
    runtime = await createConfiguredPreviewPairRuntime(s.options);
    if (!runtime?.routes.service) throw new Error("Configured runtime is required");
    const pending = await runtime.routes.service.action(f.pair.pair_id, { type: "stop", generation: 1, revision: f.pair.revision }) as { revision: number };
    expect(await runtime.routes.service.action(f.pair.pair_id, { type: "reconcile", generation: 1, revision: pending.revision }))
      .toMatchObject({ state: "cleanup_pending" });
    expect(provider.deleteServer).toHaveBeenCalledExactlyOnceWith(801);
    const retained = await f.db.executor.selectFrom("preview_pair_fixtures").select("active_pair_id").executeTakeFirstOrThrow();
    expect(retained.active_pair_id).toBe(f.pair.pair_id);
    expect(f.hetzner.createServer).not.toHaveBeenCalled();
  });
  it("retires a cancelled published request with the test bank disabled and target offline", async () => {
    const url = new URL(target.databaseUrl); url.port = "1";
    const s = options(url.toString()), loaded = loadPreviewPairConfig(s.env);
    if (!loaded.enabled) throw new Error("Enabled fixture required");
    const profile = loadPreviewPairSourceProfile(s.env, loaded)!;
    const config = { ...loaded, sourceProfileFingerprint: previewPairSourceFingerprint(profile, loaded) };
    const pairId = "44444444-4444-4444-8444-444444444444", now = Date.now();
    await preparePreviewPairCloudIntent(f.db, config, { pairId, generation: 1, pr: 3023,
      requesterId: "user_requester", sourceSha: f.pair.source_sha, controllerRunId: 42,
      profileFingerprint: config.sourceProfileFingerprint }, now);
    const operation = `projects/${profile.project}/locations/${profile.region}/operations/pair-publication`;
    await f.db.executor.updateTable("preview_pair_cloud_intents").set({ publication_id: "55555555-5555-4555-8555-555555555555",
      publication_state: "accepted", operation_name: operation }).where("pair_id", "=", pairId).execute();
    await stopPreviewPairCloudIntent(f.db, pairId, 1, 42, now);
    const fetched: string[] = [];
    s.options.fetchImpl.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); fetched.push(url.pathname);
      expect(url.origin).toBe("https://run.googleapis.com");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-google-token");
      expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname === `/v2/${operation}`) return Response.json({ name: operation, done: true });
      expect(url.pathname).toBe(`/v2/projects/${profile.project}/locations/${profile.region}/services/${profile.service}`);
      return new Response(null, { status: 404 });
    });
    runtime = await createConfiguredPreviewPairRuntime(s.options);
    await runtime!.routes.service!.reconcile({ limit: 1 });
    const saved = await f.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().where("pair_id", "=", pairId).executeTakeFirstOrThrow();
    expect(saved.state).toBe("stopped");
    expect(fetched).toHaveLength(2);
    expect(await f.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
    expect(f.hetzner.createServer).not.toHaveBeenCalled();
  });
});
