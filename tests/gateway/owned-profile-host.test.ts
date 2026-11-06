const localPaths = vi.hoisted(() => ({
  root: "",
  trust: { root: "", uid: 0 },
}));
vi.mock("@matrix-os/scope-runtime/host-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@matrix-os/scope-runtime/host-config")>();
  return {
    ...actual,
    HOST_NAMESPACE_TRUST: localPaths.trust,
    resolveScopeRuntimeHostConfig(options: Parameters<typeof actual.resolveScopeRuntimeHostConfig>[0]) {
      // Resolve and validate every canonical input first. Only physical sockets use a private test anchor.
      const config = actual.resolveScopeRuntimeHostConfig(options);
      return { ...config, supervisorSocket: localPaths.root + "/s", brokerSocket: localPaths.root + "/b" };
    },
  };
});
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { createScopeRuntimeController, SCOPE_RUNTIME_PROFILES } from "../../packages/scope-runtime/src/supervisor.js";
import { createScopeRuntimeServer } from "../../packages/scope-runtime/src/server.js";
import { nodeProfileDigest } from "../../packages/scope-runtime/src/node-runtime.js";
import { createScopeRuntimeHost } from "../../packages/gateway/src/scope-runtime-host/index.js";
import { acquireSharedAiHost, resolveGatewayScopeRuntimeDeployment } from "../../packages/gateway/src/scope-runtime-host/deployment.js";
import { startScopeRuntimeHost } from "../../packages/gateway/src/startup/scope-runtime-host.js";
import { deriveSharedAiEligibility } from "../../packages/gateway/src/collaboration/shared-ai-runtime.js";
import { LEGACY_SCOPE_RUNTIME_PROFILE_POLICY } from "../../packages/gateway/src/collaboration/scope-runtime-profile-policy.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createGatewayCollaboration } from "../../packages/gateway/src/collaboration/wiring.js";
import { createRealCollaborationTestDatabase, allowAllOrganizationPrecondition, collaborationIds } from "./collaboration-test-support.js";
import type { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { ownedProfileFixture } from "./owned-profile-fixture.js";

const cleanup: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  localPaths.root = await createUnixSocketTempDir();
  localPaths.trust.root = localPaths.root;
  localPaths.trust.uid = process.getuid!();
  cleanup.push(() => rm(localPaths.root, { recursive: true, force: true }));
  const { env } = ownedProfileFixture();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function supervisor(digests = Object.fromEntries(
  SCOPE_RUNTIME_PROFILES.map(profile => [profile.profileId, nodeProfileDigest(profile.profileDigest, ownedProfileFixture().config.ownedNode)]),
)) {
  const start = vi.fn(async () => undefined);
  const runChat = vi.fn(async () => ({ text: "bounded synthetic reply" }));
  const controller = await createScopeRuntimeController({
    executionGeneration: "7",
    launcher: {
      profileDigest: base => digests[SCOPE_RUNTIME_PROFILES.find(profile => profile.profileDigest === base)!.profileId]!,
      supportedAdapters: async id => [...SCOPE_RUNTIME_PROFILES.find(profile => profile.profileId === id)!.adapters],
      list: async () => [], start, runChat, stop: async () => undefined,
    },
  });
  const server = createScopeRuntimeServer({ socketPath: localPaths.root + "/s", controller });
  await server.start();
  cleanup.push(() => server.close());
  return { start, runChat };
}
const scopeHandle = "scope_" + "a".repeat(32);
const sandbox = {
  version: 1 as const, scopeHandle, actorId: "user_synthetic",
  worktree: { hostPath: "/srv/synthetic", mode: "rw" as const, fingerprint: "a".repeat(64) },
  network: "broker_only" as const,
};
function request(profileId: string) {
  const profile = SCOPE_RUNTIME_PROFILES.find(profile => profile.profileId === profileId)!;
  const adapter = profile.adapters[0]!;
  return { profileId, scopeHandle, workload: adapter.workloads[0]!, adapterId: adapter.adapterId,
    harnessVersion: adapter.harnessVersion, sandbox };
}

it.each(["supplied", "absent"] as const)("qualifies the configured %s host and runs a bounded request through real Unix sockets", async mode => {
  const { start, runChat } = await supervisor();
  const homePath = ownedProfileFixture().env.MATRIX_HOME;
  const deployment = resolveGatewayScopeRuntimeDeployment(homePath);
  const supplied = mode === "supplied" ? await startScopeRuntimeHost({ homePath, deployment, onFailure: vi.fn() }) : undefined;
  if (supplied) cleanup.push(() => supplied.close());
  const acquired = await acquireSharedAiHost({ homePath, deployment, host: supplied });
  if (acquired.ownedHost) cleanup.push(() => acquired.ownedHost!.close());
  expect(acquired.profilePolicy).toBe(deployment.policy);
  expect(acquired.host.available).toBe(true);
  const eligibility = await deriveSharedAiEligibility({ client: acquired.host.client, profilePolicy: acquired.profilePolicy,
    sandboxManifests: { resolve: async () => sandbox }, matrixBotEnabled: true });
  expect(eligibility).toEqual({ ...deployment.policy.sharedEligibility, matrixBot: deployment.policy.matrixBotEligibility });
  for (const profile of SCOPE_RUNTIME_PROFILES) {
    const runtime = await acquired.host.client.createRuntime(request(profile.profileId));
    if (profile === SCOPE_RUNTIME_PROFILES[0]) {
      await expect(acquired.host.client.runChat({ runtimeHandle: runtime.runtimeHandle,
        executionGeneration: runtime.executionGeneration, model: "synthetic", prompt: "bounded test" }))
        .resolves.toMatchObject({ text: "bounded synthetic reply" });
    }
    await acquired.host.client.stopRuntime({ runtimeHandle: runtime.runtimeHandle });
  }
  expect(start).toHaveBeenCalledTimes(3);
  expect(runChat).toHaveBeenCalledOnce();
});

it.each(SCOPE_RUNTIME_PROFILES.flatMap(profile => ["legacy", "foreign", "swapped"].map(mode => ({ profile, mode }))))(
  "refuses $mode identity for $profile.profileId before any launcher start", async ({ profile, mode }) => {
    const local = ownedProfileFixture();
    const foreign = ownedProfileFixture("profile-b");
    const digests = Object.fromEntries(Object.entries(local.policy.catalog).map(([id, entry]) => [id, entry.profileDigest]));
    const alternate = SCOPE_RUNTIME_PROFILES.find(candidate => candidate.profileId !== profile.profileId)!;
    digests[profile.profileId] = mode === "legacy" ? profile.profileDigest
      : mode === "foreign" ? foreign.policy.catalog[profile.profileId]!.profileDigest
      : local.policy.catalog[alternate.profileId]!.profileDigest;
    const { start } = await supervisor(digests);
    const host = await startScopeRuntimeHost({ homePath: local.env.MATRIX_HOME, onFailure: vi.fn() });
    cleanup.push(() => host!.close());
    expect(host!.client.profileCapability(profile.profileId).available).toBe(false);
    await expect(host!.client.createRuntime(request(profile.profileId))).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(start).not.toHaveBeenCalled();
  },
);

it("refuses supplied owned hosts without explicit pairing and mismatched local placement or catalog", async () => {
  const { start } = await supervisor();
  const homePath = ownedProfileFixture().env.MATRIX_HOME;
  const deployment = resolveGatewayScopeRuntimeDeployment(homePath);
  const host = (await startScopeRuntimeHost({ homePath, deployment, onFailure: vi.fn() }))!;
  cleanup.push(() => host.close());
  await expect(acquireSharedAiHost({ homePath, host })).rejects.toThrow("disagrees");
  for (const foreign of [
    { ...deployment, policy: ownedProfileFixture("profile-b").policy },
    { ...deployment, config: { ...deployment.config, supervisorSocket: localPaths.root + "/foreign" } },
    { ...deployment, config: { ...deployment.config, brokerSocket: localPaths.root + "/foreign" } },
  ]) await expect(acquireSharedAiHost({ homePath, host, deployment: foreign })).rejects.toThrow("disagrees");
  await expect(acquireSharedAiHost({ homePath: "/wrong/home", host, deployment })).rejects.toThrow("disagrees");
  expect(start).not.toHaveBeenCalled();
});

it("keeps legacy supplied callers legacy-only", async () => {
  for (const key of Object.keys(ownedProfileFixture().env)) vi.stubEnv(key, undefined);
  const { start } = await supervisor(Object.fromEntries(SCOPE_RUNTIME_PROFILES.map(profile => [profile.profileId, profile.profileDigest])));
  const homePath = localPaths.root;
  const host = await createScopeRuntimeHost({ homePath, supervisorSocket: localPaths.root + "/s",
    brokerSocket: localPaths.root + "/b", profileCatalog: LEGACY_SCOPE_RUNTIME_PROFILE_POLICY.catalog });
  cleanup.push(() => host.close());
  const acquired = await acquireSharedAiHost({ homePath, host });
  expect(acquired.profilePolicy).toBe(LEGACY_SCOPE_RUNTIME_PROFILE_POLICY);
  expect(host.available).toBe(true);
  expect(start).not.toHaveBeenCalled();
});

it("clears current proof when the configured supervisor advertises only legacy identities", async () => {
  const { start } = await supervisor(Object.fromEntries(SCOPE_RUNTIME_PROFILES.map(profile => [profile.profileId, profile.profileDigest])));
  const { createSharedAiRuntime } = await import("../../packages/gateway/src/collaboration/shared-ai-runtime.js");
  const reconcileExecutionEligibility = vi.fn(async () => ({ updated: 1 }));
  const runtime = await createSharedAiRuntime({
    homePath: ownedProfileFixture().env.MATRIX_HOME,
    chatScope: { reconcileExecutionEligibility },
  } as unknown as Parameters<typeof createSharedAiRuntime>[0]);
  cleanup.push(() => runtime.shutdown());
  expect(runtime.available).toBe(false);
  expect(reconcileExecutionEligibility).toHaveBeenCalledWith({ executionGeneration: null, eligibility: null });
  expect(start).not.toHaveBeenCalled();
});

it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL).each(["supplied", "absent"] as const)(
  "threads one policy through real collaboration startup and new PG scopes with %s host", async mode => {
    await supervisor();
    const fixture = await createRealCollaborationTestDatabase();
    cleanup.push(() => fixture.destroy());
    const homePath = ownedProfileFixture().env.MATRIX_HOME;
    const deployment = resolveGatewayScopeRuntimeDeployment(homePath);
    const repository = new ChatRepository(fixture.db, false, undefined, deployment.policy);
    await repository.bootstrap();
    const runtime = await createGatewayCollaboration({
      db: fixture.db, chatRepository: repository, organizationPrecondition: allowAllOrganizationPrecondition,
      config: { runtimeId: collaborationIds.runtime, activeKeyId: "synthetic",
        proofKeys: { synthetic: "s".repeat(32) }, platformBaseUrl: "https://unused.invalid", serviceToken: "t".repeat(32) },
      resolveParticipant: async actorId => ({ actorId, displayName: actorId }),
      resolveInvitationIdentifier: async actorId => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }), startTimers: false,
      providerSnapshotReader: { async getSnapshot() { throw new Error("No upstream invocation is allowed"); } },
    });
    const host = mode === "supplied" ? await startScopeRuntimeHost({ homePath, deployment, onFailure: vi.fn() }) : undefined;
    if (host) cleanup.push(() => host.close());
    cleanup.push(() => runtime.shutdown());
    await expect(runtime.enableSharedAi({ homePath, deployment, host, orchestrator: {} as CanonicalChatOrchestrator,
      sandboxManifests: { resolve: async () => sandbox } })).resolves.toEqual({ available: true });
    const owner = { type: "personal" as const, ownerId: "user_synthetic" };
    await repository.create(owner, { id: "chat_synthetic", clientRequestId: "req_synthetic", title: "Synthetic" });
    const input = { ownerId: owner.ownerId, organizationId: "org_synthetic", chatId: "chat_synthetic" };
    const preflight = await runtime.chatScope.preflight(input);
    const shared = await runtime.chatScope.shareChat({ ...input, clientRequestId: "50000000-0000-4000-8000-000000000011",
      payloadHash: "a".repeat(64), expectedChatRevision: preflight.chatRevision, confirmationToken: preflight.confirmationToken! });
    const scope = await fixture.db.selectFrom("collaboration_scopes").selectAll().where("id", "=", shared.id).executeTakeFirstOrThrow();
    expect(Number(scope.execution_generation)).toBe(7);
    expect(scope.execution_eligibility).toEqual(deployment.policy.sharedEligibility);
    expect(runtime.chatScope.matchesCurrentExecutionCapability({
      executionGeneration: 7, executionEligibility: scope.execution_eligibility,
    })).toBe(true);
  },
);
