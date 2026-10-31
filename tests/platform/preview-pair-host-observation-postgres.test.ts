import { requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInfo } from "../../packages/gateway/src/system-info.js";
import { CollaborationRuntimeEndpointRegistry } from "../../packages/platform/src/collaboration/runtime-endpoints.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createPreviewPairHostObserver } from "../../packages/platform/src/preview-pair/observe-host.js";
import { createPreviewPairHostRequester } from "../../packages/platform/src/preview-pair/host-request.js";
import { createProjectedPreviewPair } from "./preview-pair-projected-postgres.js";
import { createPreviewPairHostMetadata, createPreviewPairSystemInfoApp } from "./preview-pair-host-metadata.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("real host-info producer and projected registration observation", () => {
  let f: Awaited<ReturnType<typeof createProjectedPreviewPair>>, home: string, dispatcher: Agent;
  let metadata: Awaited<ReturnType<typeof createPreviewPairHostMetadata>>;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "eng418-host-info-"));
    try {
      metadata = await createPreviewPairHostMetadata(home);
      f = await createProjectedPreviewPair(["8.8.8.8", "8.8.4.4"], metadata.sha256);
      dispatcher = new Agent();
    } catch (error: unknown) { await rm(home, { recursive: true, force: true }); throw error; }
  }, 30_000);
  afterEach(async () => {
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    try { await dispatcher?.close(); } finally { try { if (home) await rm(home, { recursive: true, force: true }); } finally { await f?.destroy(); } }
  });
  async function setup() {
    const owner = f.owner, runtimeId = `vps:${owner.machine_id}`, logical = runtimeId.replace(":", "-");
    const endpoints = new CollaborationRuntimeEndpointRegistry(f.collaborationDb, { now: () => new Date(PAIR_NOW) });
    await endpoints.register({ authenticated: { runtimeId, ownerId: owner.actor_id, relayHandle: owner.handle }, registration: {
      protocolVersion: 2, runtimeId: logical, ownerId: owner.actor_id, relayHandle: owner.handle, authorityGeneration: 7,
      publicKeys: [{ keyId: "home", algorithm: "ed25519", publicKey: "B".repeat(43) }],
    } });
    await endpoints.heartbeat(logical);
    await mkdir(join(home, "system"));
    const candidate = f.source.candidate;
    const env = { MATRIX_RELEASE_FILE: metadata.releaseFile, MATRIX_BOOTSTRAP_ATTESTATION_FILE: metadata.attestationFile,
      MATRIX_HANDLE: owner.handle, MATRIX_MACHINE_ID: owner.machine_id,
      MATRIX_RUNTIME_SLOT: owner.handle, MATRIX_RUNTIME_ID: runtimeId,
      PLATFORM_INTERNAL_URL: candidate.apiOrigin, UPGRADE_TOKEN: buildPlatformVerificationToken(owner.handle, f.previewSecret),
      DATABASE_URL: "postgres://fixture@localhost/owner_test", MATRIX_COLLABORATION_DISABLED: "0" };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    for (const key of ["MATRIX_BUILD_SHA", "MATRIX_BUILD_REF", "MATRIX_BUILD_DATE"]) vi.stubEnv(key, undefined);
    expect((await f.source.db.executor.selectFrom("user_machines").select("confirmed_bundle_version").where("machine_id", "=", owner.machine_id).executeTakeFirstOrThrow()).confirmed_bundle_version).toBeNull();
    const app = createPreviewPairSystemInfoApp(home, candidate.hostBundleVersion);
    const info: SystemInfo = await (await app.request("/api/system/info")).json();
    expect(info.capabilities.collaboration).toBe(true);
    const server = { id: 1001, status: "running", publicIPv4: "8.8.4.4", labels: { app: "matrix-os", machine_id: owner.machine_id,
      clerk_user_id: owner.actor_id, runtime_slot: owner.handle } };
    const getServer = vi.fn(async () => server);
    const provider = { ...f.source.hetzner, getServer, withSignal: vi.fn(() => ({ ...f.source.hetzner, getServer })) };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      // Transport boundary fixture: NEVER make a real request to these example public IPs.
      expect(String(url)).toBe("https://8.8.4.4:443/api/system/info");
      expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${env.UPGRADE_TOKEN}`);
      return Response.json(info);
    });
    const observe = createPreviewPairHostObserver({ db: f.source.db, target: f.target.db, provider,
      previewSecret: f.previewSecret, controlSecret: "c".repeat(48), dispatcher, fetchImpl, now: () => PAIR_NOW });
    const member = { role: "owner" as const, machineId: owner.machine_id, actorId: owner.actor_id, handle: owner.handle, tokenEpoch: 1 };
    return { info, server, provider, endpoints, logical, fetchImpl, observe, member };
  }
  it("binds AI configuration transport to the canonical provider/IP and replaces caller authority", async () => {
    const s = await setup(), signal = new AbortController().signal;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://8.8.4.4:443/api/internal/platform-funded-ai/config");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${buildPlatformVerificationToken(s.member.handle, f.previewSecret)}`);
      expect(headers.get("host")).toBeNull(); expect(headers.get("origin")).toBeNull();
      expect(init).toMatchObject({ method: "POST", body: "{}", redirect: "error", cache: "no-store" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ accepted: true });
    });
    const request = createPreviewPairHostRequester({ db: f.source.db, provider: s.provider,
      previewSecret: f.previewSecret, controlSecret: f.controlSecret, dispatcher, fetchImpl, now: () => PAIR_NOW });
    const result = await request(s.member, "/api/internal/platform-funded-ai/config", {
      method: "POST", body: "{}", redirect: "follow", headers: { authorization: "Bearer caller-controlled", host: "169.254.169.254", origin: "https://untrusted.example" },
    }, signal);
    expect(await result.response.json()).toEqual({ accepted: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const [path, init] of [
      ["https://169.254.169.254/api/system/info", { method: "GET" }],
      ["/api/system/info", { method: "POST", body: "{}" }],
      ["/api/internal/platform-funded-ai/config", { method: "GET", body: "{}" }],
      ["/api/internal/platform-funded-ai/config", { method: "POST", body: "x".repeat(4097) }],
    ] as const) await expect(request(s.member, path, init, signal)).rejects.toThrow("unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("observes installed/running bytes from the actual producer and fresh owner control metadata", async () => {
    const s = await setup();
    expect(await s.observe(s.member, new AbortController().signal)).toMatchObject({ role: s.member.role, actorId: s.member.actorId, machineId: s.member.machineId, handle: s.member.handle, runtimeSlot: s.member.handle,
      installedVersion: f.source.candidate.hostBundleVersion, runningVersion: f.source.candidate.hostBundleVersion,
      installedSha: f.source.candidate.sourceSha, runningSha: f.source.candidate.sourceSha,
      authorityGeneration: 7, healthy: true, bundleSha256: f.source.candidate.hostBundleSha256,
      lastControlAt: new Date(PAIR_NOW).toISOString(), observedAt: new Date(PAIR_NOW).toISOString() });
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatched runtime, installed bytes, running bytes and disabled collaboration", async () => {
    const s = await setup();
    const faults = [
      { ...s.info, runningVersion: "old" }, { ...s.info, build: { ...s.info.build, sha: "d".repeat(40) } },
      { ...s.info, release: { ...s.info.release, version: "old" } },
      { ...s.info, release: { ...s.info.release, gitCommit: "d".repeat(40) } },
      { ...s.info, release: { ...s.info.release, sha256: "d".repeat(64) } },
      { ...s.info, release: { ...s.info.release, bundleSha256: "d".repeat(64) } },
      { ...s.info, runtime: { ...s.info.runtime, machineId: "44444444-4444-4444-8444-444444444444" } },
      { ...s.info, runtime: { ...s.info.runtime, runtimeSlot: "primary" } },
      { ...s.info, capabilities: { ...s.info.capabilities, collaboration: false } },
      { ...s.info, capabilities: { ...s.info.capabilities, collaborationDirectProtocolVersion: 1 } },
    ];
    for (const info of faults) {
      s.fetchImpl.mockClear();
      s.fetchImpl.mockImplementationOnce(async () => Response.json(info));
      await expect(s.observe(s.member, new AbortController().signal)).rejects.toThrow("unavailable");
      expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects stale control and recovers only after an actual heartbeat; a bad provider cannot cause a host probe", async () => {
    const s = await setup();
    await f.collaborationDb.updateTable("collaboration_runtime_endpoints").set({ last_control_at: new Date(PAIR_NOW - 60_001) })
      .where("runtime_id", "=", s.logical).execute();
    await expect(s.observe(s.member, new AbortController().signal)).rejects.toThrow("unavailable");
    await s.endpoints.heartbeat(s.logical);
    await expect(s.observe(s.member, new AbortController().signal)).resolves.toMatchObject({ authorityGeneration: 7 });
    s.fetchImpl.mockClear(); s.server.labels.clerk_user_id = "user_unrelated";
    await expect(s.observe(s.member, new AbortController().signal)).rejects.toThrow("unavailable");
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  it("cancels unsuccessful probe bodies and bounds successful bodies", async () => {
    const s = await setup(), cancel = vi.fn();
    s.fetchImpl.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel,
    }), { status: 401 }));
    await expect(s.observe(s.member, new AbortController().signal)).rejects.toThrow("unavailable");
    expect(cancel).toHaveBeenCalledTimes(1);
    s.fetchImpl.mockImplementationOnce(async () => new Response("x".repeat(64 * 1024 + 1)));
    await expect(s.observe(s.member, new AbortController().signal)).rejects.toThrow("unavailable");
  });
  it("blocks unsafe registered addresses before provider/host calls", async () => {
    const s = await setup();
    for (const public_ipv4 of ["127.0.0.1", "169.254.169.254", "203.0.113.10", "10.0.0.1", "8.8.8.8:443"]) {
      await f.source.db.executor.updateTable("user_machines").set({ public_ipv4 }).where("machine_id", "=", s.member.machineId).execute();
      await expect(s.observe(s.member, new AbortController().signal)).rejects.toThrow("unavailable");
    }
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects completion after canonical retirement and never restores readiness", async () => {
    const s = await setup();
    s.fetchImpl.mockImplementationOnce(async () => {
      const pair = await f.source.db.executor.selectFrom("preview_pairs").select("revision").where("pair_id", "=", f.source.pair.pair_id).executeTakeFirstOrThrow();
      await requestPreviewPairStop(f.source.db, f.source.pair.pair_id, 1, pair.revision, PAIR_NOW);
      return Response.json(s.info);
    });
    await expect(s.observe(s.member, new AbortController().signal)).rejects.toThrow("unavailable");
    expect((await f.source.db.executor.selectFrom("preview_pairs").select("state").executeTakeFirstOrThrow()).state).toBe("cleanup_pending");
    // Host/control remain healthy while canonical cleanup is pending.
    expect(await s.endpoints.resolve(s.logical)).not.toBeNull();
  });

});
