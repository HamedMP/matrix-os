import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "@matrix-os/scope-runtime/profile";
import {
  SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST,
  SCOPE_RUNTIME_SANDBOX_POLICY_VERSION,
} from "@matrix-os/scope-runtime/sandbox";
import type { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import {
  createGatewayCollaboration,
  loadGatewayCollaborationConfig,
} from "../../packages/gateway/src/collaboration/wiring.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { evaluateCollaborationReadiness, type ReadinessProbes } from "../../packages/gateway/src/collaboration/readiness-evaluator.js";
import { OrganizationMembershipClient } from "../../packages/gateway/src/collaboration/organization-membership-client.js";
import { createLazyProviderSnapshotReader } from "../../packages/gateway/src/collaboration/lazy-provider-snapshot-reader.js";
import {
  allowAllOrganizationPrecondition,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

describe("gateway collaboration wiring", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("fails closed on incomplete environment configuration", () => {
    expect(loadGatewayCollaborationConfig({})).toBeNull();
    expect(loadGatewayCollaborationConfig({
      MATRIX_RUNTIME_ID: collaborationIds.runtime,
      MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
      MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
      MATRIX_COLLABORATION_PREFLIGHT_SECRET: "b".repeat(32),
      PLATFORM_INTERNAL_URL: "https://platform.internal",
      UPGRADE_TOKEN: "c".repeat(32),
    })).toMatchObject({ runtimeId: collaborationIds.runtime });
  });

  it("derives the VPS runtime ID from the existing machine identity", () => {
    expect(loadGatewayCollaborationConfig({
      MATRIX_MACHINE_ID: "11111111-1111-4111-8111-111111111111",
      MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
      MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
      MATRIX_COLLABORATION_PREFLIGHT_SECRET: "b".repeat(32),
      PLATFORM_INTERNAL_URL: "https://platform.internal",
      UPGRADE_TOKEN: "c".repeat(32),
    })).toMatchObject({ runtimeId: "vps:11111111-1111-4111-8111-111111111111" });
  });

  it("resolves dependencies before route registration and drains before database disposal", async () => {
    const runtime = await createGatewayCollaboration({
      organizationPrecondition: allowAllOrganizationPrecondition,
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    const app = new Hono();
    let registeredSocket = false;
    const upgradeWebSocket = ((factory: (context: Context) => WSEvents<unknown>) => {
      registeredSocket = typeof factory === "function";
      return (context: Context) => context.text("upgrade");
    }) as unknown as UpgradeWebSocket;
    runtime.register({ app, upgradeWebSocket });
    expect(registeredSocket).toBe(true);
    expect(await fixture.db.selectFrom("collaboration_schema_migrations").select("version").execute())
      .toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
      ]);
    await expect(app.request(`/api/collaboration/scopes/${collaborationIds.scope}/discussion/messages`))
      .resolves.toMatchObject({ status: 401 });
    await runtime.shutdown();
    await expect(runtime.outbox.runOnce()).resolves.toBe(0);
  });

  it("authorizes an accepted preset grant through the wired authority on chat, project and terminal scopes", async () => {
    const organizationId = "org_wiring_primary";
    const members = new Set(["user_wiring_owner", "user_wiring_member"]);
    const runtime = await createGatewayCollaboration({
      organizationMembershipSource: {
        async assertMembership({ actorId, organizationId: requested }) {
          return requested === organizationId && members.has(actorId)
            ? { member: true, expiresAt: new Date(Date.now() + 20_000).toISOString(), aiSubmission: "owner_only" as const, membershipEpoch: "1" }
            : { member: false };
        },
      },
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    const now = new Date().toISOString();
    const scopes = [
      { id: "10000000-0000-4000-8000-00000000a001", kind: "chat" as const, resourceId: "chat_wiring" },
      { id: "10000000-0000-4000-8000-00000000a002", kind: "project" as const, resourceId: "project_wiring" },
      { id: "10000000-0000-4000-8000-00000000a003", kind: "terminal" as const, resourceId: "terminal_wiring" },
    ];
    for (const scope of scopes) {
      await fixture.db.insertInto("collaboration_scopes").values({
        id: scope.id, owner_type: "personal", owner_id: "user_wiring_owner", organization_id: organizationId,
        kind: scope.kind, resource_id: scope.resourceId, parent_scope_id: null, membership_mode: "direct", lifecycle: "shared",
        revision: 1, auth_epoch: 1, authority_runtime_id: collaborationIds.runtime, authority_generation: 1,
        execution_generation: null, execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now,
      }).execute();
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: scope.id, actor_id: "user_wiring_owner", role: "owner", status: "accepted", organization_id: organizationId,
        invitation_id: null, invited_by: "user_wiring_owner", accepted_at: now, expires_at: null, revision: 1, joined_at: now, updated_at: now,
        dispositioned_at: null,
      }).execute();
      await expect(runtime.authority.authorize({ scopeId: scope.id, actorId: "user_wiring_member", action: "read" }))
        .rejects.toMatchObject({ code: "not_found" });
      const grant = await runtime.capabilities.createGrant({
        scopeId: scope.id, actorId: "user_wiring_owner", clientRequestId: crypto.randomUUID(), expectedRevision: 1, payloadHash: "a".repeat(64),
        audience: { kind: "member", actorId: "user_wiring_member" }, preset: "contributor", policyVersion: "v1",
      });
      await runtime.capabilities.acceptGrant({ grantId: grant.grantId, actorId: "user_wiring_member", membershipEvidenceEpoch: "1" });
      await expect(runtime.authority.authorize({ scopeId: scope.id, actorId: "user_wiring_member", action: "read" }))
        .resolves.toMatchObject({ role: "editor", organizationId, resourceKind: scope.kind });
      await expect(runtime.authority.authorize({ scopeId: scope.id, actorId: "user_wiring_member", action: "discuss" }))
        .resolves.toMatchObject({ role: "editor" });
    }
    // The event WebSocket path authorizes through the same wired authority.
    const socket = { sent: [] as string[], closed: false, send(value: string) { this.sent.push(value); }, close() { this.closed = true; } };
    const connection = await runtime.eventRegistry.open({
      connectionId: "conn_wiring_member", scopeId: scopes[0]!.id, actorId: "user_wiring_member", authorityGeneration: 1, socket,
    });
    expect(socket.closed).toBe(false);
    connection.close();
    members.delete("user_wiring_member");
    await expect(runtime.authority.authorize({ scopeId: scopes[0]!.id, actorId: "user_wiring_member", action: "read" }))
      .rejects.toMatchObject({ code: "not_found" });
    await runtime.shutdown();
  });

  it("registers M3 routes only after terminal dependencies are resolved and drains them on shutdown", async () => {
    const runtime = await createGatewayCollaboration({
      organizationPrecondition: allowAllOrganizationPrecondition,
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    runtime.enableSharedTerminal({
      registry: {
        get: async () => { throw Object.assign(new Error("missing"), { code: "session_not_found" }); },
        bindCollaboration: async () => { throw new Error("not called"); },
        unbindCollaboration: async () => undefined,
        setContributorControl: async () => { throw new Error("not called"); },
      },
      runtime: {
        input: async () => undefined,
        paste: async () => undefined,
        resize: async () => undefined,
        stop: async () => undefined,
      },
      executionEligibility: {
        profileId: "scope-runtime-terminal-v1",
        profileVersion: 1,
        profileDigest: "d".repeat(64),
        adapterId: "terminal",
        harnessVersion: "1.0.0",
      },
    });
    const app = new Hono();
    let registeredSockets = 0;
    const upgradeWebSocket = ((factory: (context: Context) => WSEvents<unknown>) => {
      if (typeof factory === "function") registeredSockets += 1;
      return (context: Context) => context.text("upgrade");
    }) as unknown as UpgradeWebSocket;
    runtime.register({ app, upgradeWebSocket });
    // Legacy events + terminal sockets plus the S05 direct events + terminal sockets.
    expect(registeredSockets).toBe(4);
    await expect(app.request(`/api/collaboration/scopes/${collaborationIds.scope}/terminal`))
      .resolves.toMatchObject({ status: 401 });
    expect(() => runtime.enableSharedTerminal({} as never)).toThrow(/exactly once/);
    await runtime.shutdown();
  });

  it("removes expired owner-local export artifacts during startup recovery", async () => {
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: collaborationIds.scope,
      owner_type: "personal",
      owner_id: "user_owner",
      kind: "chat",
      organization_id: "org_matrix_team",
      resource_id: collaborationIds.chat,
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      authority_runtime_id: collaborationIds.runtime,
      execution_generation: null,
      execution_eligibility: null,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      deleted_at: null,
    }).execute();
    await fixture.db.insertInto("collaboration_exports").values({
      id: "50000000-0000-4000-8000-000000000001",
      scope_id: collaborationIds.scope,
      owner_id: "user_owner",
      payload: {},
      created_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-09-02T00:00:00.000Z",
    }).execute();

    const runtime = await createGatewayCollaboration({
      organizationPrecondition: allowAllOrganizationPrecondition,
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    expect(await fixture.db.selectFrom("collaboration_exports").select("id").execute()).toEqual([]);
    await runtime.shutdown();
  });

  it("enables M2 only after the exact scope-runtime profile is available", async () => {
    const temp = await mkdtemp(join(tmpdir(), "matrix-shared-ai-wiring-"));
    const supervisorSocket = join(temp, "supervisor.sock");
    const brokerSocket = join(temp, "broker.sock");
    const supervisor = await startSupervisor(supervisorSocket);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedSharedChat(fixture);
    const runtime = await createGatewayCollaboration({
      organizationPrecondition: allowAllOrganizationPrecondition,
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    try {
      await expect(runtime.enableSharedAi({
        orchestrator: {} as unknown as CanonicalChatOrchestrator,
        homePath: temp,
        supervisorSocket,
        brokerSocket,
        sandboxManifests,
      })).resolves.toEqual({ available: true });
      await expect(fixture.db.selectFrom("collaboration_scopes")
        .select(["execution_generation", "execution_eligibility"])
        .where("id", "=", collaborationIds.scope).executeTakeFirstOrThrow())
        .resolves.toMatchObject({
          execution_generation: 7,
          execution_eligibility: {
            profileId: SCOPE_RUNTIME_PROFILE_ID,
            profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
          },
        });

      const postStartupChatId = "chat_created_after_gateway_startup";
      await fixture.db.insertInto("chats").values({
        id: postStartupChatId,
        owner_type: "personal",
        owner_id: "user_owner",
        create_request_id: "req_post_startup_shared_chat",
        project_id: null,
        title: "Post-startup shared Chat",
        lifecycle: "active",
        attention: "none",
        collaboration: null,
        user_state: null,
        shell_state: null,
        fork_provenance: null,
        last_message_preview: null,
        current_selection: null,
        bound_driver_kind: null,
        bound_instance_id: null,
        bound_at_turn_id: null,
        created_at: "2026-09-10T00:00:00.000Z",
        updated_at: "2026-09-10T00:00:00.000Z",
      }).execute();
      const preflight = await runtime.chatScope.preflight({ ownerId: "user_owner", organizationId: "org_matrix_team", chatId: postStartupChatId });
      const created = await runtime.chatScope.shareChat({
        ownerId: "user_owner",
        organizationId: "org_matrix_team",
        chatId: postStartupChatId,
        clientRequestId: "50000000-0000-4000-8000-000000000099",
        payloadHash: "e".repeat(64),
        expectedChatRevision: preflight.chatRevision,
        confirmationToken: preflight.confirmationToken!,
      });
      await expect(fixture.db.selectFrom("collaboration_scopes")
        .select(["execution_generation", "execution_eligibility"])
        .where("id", "=", created.id).executeTakeFirstOrThrow())
        .resolves.toMatchObject({
          execution_generation: 7,
          execution_eligibility: {
            profileId: SCOPE_RUNTIME_PROFILE_ID,
            profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
          },
        });
    } finally {
      await runtime.shutdown();
      await new Promise<void>((resolve) => supervisor.close(() => resolve()));
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("keeps collaboration available with M2 disabled when the broker socket cannot start", async () => {
    const temp = await mkdtemp(join(tmpdir(), "matrix-shared-ai-broker-failure-"));
    const supervisorSocket = join(temp, "supervisor.sock");
    const brokerSocket = join(temp, "broker.sock");
    const supervisor = await startSupervisor(supervisorSocket);
    await writeFile(brokerSocket, "unsafe non-socket path", { flag: "wx" });
    await bootstrapCollaborationDatabase(fixture.db);
    await seedSharedChat(fixture);
    const runtime = await createGatewayCollaboration({
      organizationPrecondition: allowAllOrganizationPrecondition,
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    try {
      await expect(runtime.enableSharedAi({
        orchestrator: {} as unknown as CanonicalChatOrchestrator,
        homePath: temp,
        supervisorSocket,
        brokerSocket,
      })).resolves.toEqual({ available: false });
      await expect(fixture.db.selectFrom("collaboration_scopes")
        .select(["execution_generation", "execution_eligibility"])
        .where("id", "=", collaborationIds.scope).executeTakeFirstOrThrow())
        .resolves.toMatchObject({ execution_generation: null, execution_eligibility: null });
    } finally {
      await runtime.shutdown();
      await new Promise<void>((resolve) => supervisor.close(() => resolve()));
      await rm(temp, { recursive: true, force: true });
    }
  });
  it.each([
    { name: "the supervisor lacks the pinned sandbox policy", sandbox: false, source: sandboxManifests },
    { name: "no sandbox manifest source is wired", sandbox: true, source: undefined },
  ])("keeps shared AI disabled and eligibility empty when $name", async ({ sandbox, source }) => {
    const temp = await mkdtemp(join(tmpdir(), "matrix-shared-ai-wiring-"));
    const supervisorSocket = join(temp, "supervisor.sock");
    const brokerSocket = join(temp, "broker.sock");
    const supervisor = await startSupervisor(supervisorSocket, { sandbox });
    await bootstrapCollaborationDatabase(fixture.db);
    await seedSharedChat(fixture);
    const runtime = await createGatewayCollaboration({
      organizationPrecondition: allowAllOrganizationPrecondition,
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    try {
      await expect(runtime.enableSharedAi({
        orchestrator: {} as unknown as CanonicalChatOrchestrator,
        homePath: temp,
        supervisorSocket,
        brokerSocket,
        ...(source ? { sandboxManifests: source } : {}),
      })).resolves.toEqual({ available: false });
      await expect(fixture.db.selectFrom("collaboration_scopes")
        .select(["execution_generation", "execution_eligibility"])
        .where("id", "=", collaborationIds.scope).executeTakeFirstOrThrow())
        .resolves.toMatchObject({ execution_generation: null, execution_eligibility: null });
      // The readiness seam the preflight composition reads is false whenever shared AI is not running,
      // but only for the kinds that execute: a file or folder share needs no sandbox at all.
      const subject = { ownerId: "user_owner", scopeId: collaborationIds.scope, organizationId: "org_1" };
      for (const resourceKind of ["chat", "project"] as const) {
        await expect(runtime.sandboxSupported({ ...subject, resourceKind })).resolves.toBe(false);
      }
      for (const resourceKind of ["file", "folder", "app_instance", "terminal"] as const) {
        await expect(runtime.sandboxSupported({ ...subject, resourceKind })).resolves.toBe(true);
      }
    } finally {
      await runtime.shutdown();
      await new Promise<void>((resolve) => supervisor.close(() => resolve()));
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("answers the readiness composition from the live supervisor: executing kinds are unsupported once the sandbox policy is gone", async () => {
    const temp = await mkdtemp(join(tmpdir(), "matrix-shared-ai-wiring-"));
    const supervisorSocket = join(temp, "supervisor.sock");
    const brokerSocket = join(temp, "broker.sock");
    const advertised = { sandbox: true };
    const supervisor = await startSupervisor(supervisorSocket, { sandbox: () => advertised.sandbox });
    await bootstrapCollaborationDatabase(fixture.db);
    await seedSharedChat(fixture);
    const runtime = await createGatewayCollaboration({
      organizationPrecondition: allowAllOrganizationPrecondition,
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    try {
      await expect(runtime.enableSharedAi({
        orchestrator: {} as unknown as CanonicalChatOrchestrator,
        homePath: temp,
        supervisorSocket,
        brokerSocket,
        sandboxManifests,
      })).resolves.toEqual({ available: true });
      // The preflight readiness composition reads `supported` from this seam.
      const probes: ReadinessProbes = {
        hostOnline: async () => true,
        supported: (subject) => runtime.sandboxSupported(subject),
        gitIdentity: async () => ({ configured: true }),
        forgeCredential: async () => ({ configured: true }),
        aiSource: async () => ({ configured: true, sourceKind: "owner_account" as const }),
        submitMode: async () => "owner_only" as const,
        chatRootInventory: async () => ({ chatRootCount: 1, dirtyRootCount: 0, unresolved: 0 }),
      };
      const subject = { ownerId: "user_owner", scopeId: collaborationIds.scope, organizationId: "org_1" };
      for (const resourceKind of ["project", "chat"] as const) {
        const readiness = await evaluateCollaborationReadiness({ ...subject, resourceKind }, probes);
        expect(readiness.state).not.toBe("unsupported");
      }
      // A startup snapshot is not trusted: the host drops the pinned policy and the next check is unsupported.
      advertised.sandbox = false;
      for (const resourceKind of ["project", "chat"] as const) {
        const readiness = await evaluateCollaborationReadiness({ ...subject, resourceKind }, probes);
        expect(readiness.state).toBe("unsupported");
      }
      // Nothing executes for a file, so it stays shareable without the sandbox policy.
      const file = await evaluateCollaborationReadiness({ ...subject, resourceKind: "file" }, probes);
      expect(file.state).not.toBe("unsupported");
    } finally {
      await runtime.shutdown();
      await new Promise<void>((resolve) => supervisor.close(() => resolve()));
      await rm(temp, { recursive: true, force: true });
    }
  });
});

const sandboxManifests = {
  resolve: async (input: { scopeHandle: string; requestingActorId: string }) => ({
    version: 1 as const,
    scopeHandle: input.scopeHandle,
    actorId: input.requestingActorId,
    worktree: { hostPath: "/home/matrix/home/projects/launch-site", mode: "rw" as const, fingerprint: "a".repeat(64) },
    network: "none" as const,
  }),
};

async function startSupervisor(path: string, options: { sandbox?: boolean | (() => boolean) } = {}): Promise<Server> {
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk) => { body += chunk; });
    socket.once("end", () => {
      const request = JSON.parse(body.trim()) as { requestId: string; type: string };
      if (request.type !== "capability.get") return socket.destroy();
      socket.end(`${JSON.stringify({
        version: 1,
        type: "capability.result",
        requestId: request.requestId,
        ok: true,
        supervisorVersion: "1.0.0",
        profile: {
          profileId: SCOPE_RUNTIME_PROFILE_ID,
          profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
          profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
          executionGeneration: "7",
          identity: { mode: "dynamic", uidMin: 61_184, uidMax: 65_519 },
          limits: {
            memoryMaxBytes: 1_073_741_824,
            cpuQuotaPercent: 200,
            tasksMax: 256,
            storageMaxBytes: 10_737_418_240,
          },
          adapters: [{
            adapterId: "claude-code",
            harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
            workloads: ["chat_ai"],
          }],
          ...((typeof options.sandbox === "function" ? options.sandbox() : options.sandbox) === false ? {} : { sandbox: {
            policyVersion: SCOPE_RUNTIME_SANDBOX_POLICY_VERSION,
            policyDigest: SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST,
            workloads: ["chat_ai"],
          } }),
        },
      })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

async function seedSharedChat(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("chats").values({
    id: collaborationIds.chat,
    owner_type: "personal",
    owner_id: "user_owner",
    create_request_id: "req_shared_wiring",
    project_id: null,
    title: "Shared wiring",
    lifecycle: "active",
    attention: "none",
    collaboration: {
      scopeId: collaborationIds.scope,
      mode: "discussion_only",
      executionFenced: true,
    },
    user_state: null,
    shell_state: null,
    fork_provenance: null,
    last_message_preview: null,
    current_selection: null,
    bound_driver_kind: null,
    bound_instance_id: null,
    bound_at_turn_id: null,
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-10T00:00:00.000Z",
  }).execute();
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope,
    owner_type: "personal",
    owner_id: "user_owner",
    kind: "chat",
    organization_id: "org_matrix_team",
    resource_id: collaborationIds.chat,
    parent_scope_id: null,
    membership_mode: "direct",
    lifecycle: "shared",
    authority_runtime_id: collaborationIds.runtime,
    execution_generation: null,
    execution_eligibility: null,
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-10T00:00:00.000Z",
    deleted_at: null,
  }).execute();
}

describe("S08 owner source wiring", () => {
  it("production path: the default membership client supplies organization AI submission and the lazy V3 reader constructs policies, bindings and the owner source", async () => {
    const fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { actors: Array<{ organizationId: string; actorId: string }> };
      seen.push(String(input));
      const now = Date.now();
      return new Response(JSON.stringify(body.actors.map((actor) => ({
        protocolVersion: 2, type: "membership_assertion", organizationId: actor.organizationId, actorId: actor.actorId,
        membershipEpoch: "3", member: true, aiSubmission: "members",
        requestStartedAt: new Date(now).toISOString(), expiresAt: new Date(now + 15_000).toISOString(),
      }))), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new OrganizationMembershipClient({
      platformBaseUrl: "https://platform.internal", runtimeId: collaborationIds.runtime, serviceToken: "c".repeat(32), fetchImpl,
    });
    const runtime = await createGatewayCollaboration({
      // Same construction as server.ts: the membership client is the default source, no precondition override.
      organizationMembershipSource: client,
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId: string) => ({ actorId, displayName: actorId }),
      resolveInvitationIdentifier: async (identifier: string) => ({ actorId: identifier, displayName: identifier }),
      startTimers: false,
      providerSnapshotReader: { async getSnapshot() { throw new Error("ProviderSnapshotUnavailable"); } },
    });
    try {
      expect(runtime.executionPolicies).toBeDefined();
      expect(runtime.runBindings).toBeDefined();
      expect(runtime.ownerSource).toBeDefined();
      expect(await runtime.executionPolicies!.organizationAiSubmissionFor("org_wiring_primary", "user_wiring_owner")).toBe("members");
      expect(seen).toEqual(["https://platform.internal/internal/organizations/access/resolve"]);
    } finally {
      await runtime.shutdown();
      await fixture.destroy();
    }
  });

  it("gives production construction a lazy reader that fails closed until the provider service attaches", async () => {
    // server.ts builds the collaboration runtime before the owner's Provider V3 service exists.
    const lazy = createLazyProviderSnapshotReader();
    await expect(lazy.reader.getSnapshot()).rejects.toThrow(/ProviderSnapshotUnavailable/);
    const snapshot = { schemaVersion: 3 } as unknown as Awaited<ReturnType<typeof lazy.reader.getSnapshot>>;
    const getSnapshot = vi.fn(async () => snapshot);
    lazy.attach({ getSnapshot });
    await expect(lazy.reader.getSnapshot({ refresh: true })).resolves.toBe(snapshot);
    expect(getSnapshot).toHaveBeenCalledWith({ refresh: true });
    expect(() => lazy.attach({ getSnapshot })).toThrow(/already attached/i);
    const fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    const runtime = await createGatewayCollaboration({
      organizationPrecondition: allowAllOrganizationPrecondition,
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId: string) => ({ actorId, displayName: actorId }),
      startTimers: false,
      providerSnapshotReader: lazy.reader,
    });
    try {
      expect(runtime.executionPolicies).toBeDefined();
      expect(runtime.runBindings).toBeDefined();
      expect(runtime.ownerSource).toBeDefined();
    } finally {
      await runtime.shutdown();
      await fixture.destroy();
    }
  });

  it("constructs execution policies, run bindings and the owner source only when a V3 snapshot reader is provided", async () => {
    const fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    const config = {
      runtimeId: collaborationIds.runtime,
      activeKeyId: "key-1",
      proofKeys: { "key-1": "a".repeat(32) },
      preflightSecret: "b".repeat(32),
      platformBaseUrl: "https://platform.internal",
      serviceToken: "c".repeat(32),
    };
    const base = {
      organizationPrecondition: allowAllOrganizationPrecondition,
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config,
      resolveParticipant: async (actorId: string) => ({ actorId, displayName: actorId }),
      resolveInvitationIdentifier: async (identifier: string) => ({ actorId: identifier, displayName: identifier }),
      startTimers: false,
    };
    try {
      const without = await createGatewayCollaboration(base);
      expect(without.executionPolicies).toBeUndefined();
      expect(without.runBindings).toBeUndefined();
      expect(without.ownerSource).toBeUndefined();
      await without.shutdown();

      const withReader = await createGatewayCollaboration({
        ...base,
        providerSnapshotReader: { async getSnapshot() { throw new Error("snapshot never read at construction"); } },
      });
      expect(withReader.executionPolicies).toBeDefined();
      expect(withReader.runBindings).toBeDefined();
      expect(withReader.ownerSource).toBeDefined();
      expect(await withReader.executionPolicies!.effectiveSubmitMode(collaborationIds.scope)).toBe("owner_only");
      const app = new Hono();
      withReader.register({ app, upgradeWebSocket: () => (async () => new Response(null, { status: 426 })) as never });
      const policyRoutes = app.routes.filter((route) => route.path === "/api/collaboration/scopes/:scopeId/execution-policy" && route.method !== "ALL");
      expect(policyRoutes.map((route) => route.method).sort()).toEqual(["GET", "PUT"]);
      await withReader.shutdown();
    } finally {
      await fixture.destroy();
    }
  });
});
