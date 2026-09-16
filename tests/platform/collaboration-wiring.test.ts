import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlatformCollaboration,
  loadPlatformCollaborationConfig,
} from "../../packages/platform/src/collaboration/wiring.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const scopeId = "10000000-0000-4000-8000-000000000001";

describe("platform collaboration wiring", () => {
  let fixture: PlatformCollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
  });

  afterEach(async () => {
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  it("fails closed on incomplete environment configuration", () => {
    expect(loadPlatformCollaborationConfig({ MATRIX_COLLABORATION_ENABLED: "true" })).toBeNull();
    expect(loadPlatformCollaborationConfig({
      MATRIX_COLLABORATION_ENABLED: "true",
      MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
      MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
      MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com",
    })).toMatchObject({ activeKeyId: "key-1", enabledPurposes: ["events"] });
  });

  it("registers local and exact proxy routes after migrations", async () => {
    const terminalScopeId = "10000000-0000-4000-8000-000000000002";
    const projectScopeId = "10000000-0000-4000-8000-000000000003";
    const upstream = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input).endsWith("/project")
        ? {
          id: "proj_alpha", scopeId: projectScopeId, status: "active",
          resources: [{ kind: "file", id: "README.md", revision: "1", readiness: "ready" }],
        }
        : String(input).includes(projectScopeId)
          ? {
            id: projectScopeId,
            ownerId: platformCollaborationActors.owner,
            kind: "project",
            resourceId: "proj_alpha",
            membershipMode: "direct",
            lifecycle: "shared",
            revision: "1",
            authEpoch: "1",
            authorityGeneration: "2",
            role: "editor",
            capabilities: { read: true, discuss: true, manageMembers: false, requestAi: true,
              observeTerminal: false, controlTerminal: false, stopTerminal: false },
          }
          : String(input).endsWith("/terminal")
        ? {
          id: "terminal_release", scopeId: terminalScopeId, incarnation: `terminal-${"a".repeat(32)}`,
          executionGeneration: "4", status: "active",
          createdBy: { actorId: platformCollaborationActors.owner, displayName: "Owner" },
          createdAt: "2026-09-07T12:00:00.000Z",
        }
        : String(input).includes(terminalScopeId)
          ? {
            id: terminalScopeId,
            ownerId: platformCollaborationActors.owner,
            kind: "terminal",
            resourceId: "terminal_release",
            membershipMode: "direct",
            lifecycle: "shared",
            revision: "2",
            authEpoch: "1",
            authorityGeneration: "1",
            role: "viewer",
            capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false,
              observeTerminal: true, controlTerminal: false, stopTerminal: false },
          }
          : String(input).endsWith("/chat")
        ? { id: "chat_one", scopeId, title: "Shared planning", lifecycle: "active", revision: "2", messageCount: "3" }
        : {
          id: scopeId,
          ownerId: platformCollaborationActors.owner,
          kind: "chat",
          resourceId: "chat_one",
          membershipMode: "direct",
          lifecycle: "shared",
          revision: "2",
          authEpoch: "1",
          authorityGeneration: "1",
          role: "editor",
          capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false },
        },
    ), {
      headers: { "content-type": "application/json" },
    }));
    const runtime = await createPlatformCollaboration({
      db: fixture.collaborationDb,
      config: {
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        allowedOrigins: ["https://app.matrix-os.com"],
        enabledPurposes: ["events", "terminal"],
      },
      resolveActor: async (c) => c.req.header("x-test-actor") ?? null,
      authenticateRuntime: async () => null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      resolveRuntime: async (runtimeId) => ({
        runtimeId,
        ownerId: platformCollaborationActors.owner,
        baseUrl: "https://runtime.internal",
      }),
      fetchImpl: upstream,
      now: () => new Date("2026-09-07T12:00:00.000Z"),
    });
    await runtime.repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000001",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "chat",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "accepted" }],
    });
    await runtime.repository.setPolicy({
      milestone: "m1",
      expectedRevision: 0,
      mode: "enabled",
      cohort: [],
      changedBy: "operator_test",
    });
    const app = new Hono();
    runtime.register(app);
    const response = await app.request(`/api/collaboration/scopes/${scopeId}`, {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: scopeId, role: "editor" });
    expect(upstream).toHaveBeenCalledOnce();
    const [, init] = upstream.mock.calls[0]!;
    expect(new Headers(init?.headers).has("x-matrix-collaboration-proof")).toBe(true);

    const discovery = await app.request("/api/collaboration/shared", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ items: [{ resource: {
      scope: { id: scopeId, role: "editor" },
      chat: { id: "chat_one", title: "Shared planning" },
    } }] });

    await runtime.repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000002",
      scopeId: terminalScopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "terminal",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "accepted" }],
    });
    await runtime.repository.setPolicy({
      milestone: "m3",
      expectedRevision: 0,
      mode: "enabled",
      cohort: [],
      changedBy: "operator_test",
    });
    const terminalDiscovery = await app.request("/api/collaboration/shared", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(terminalDiscovery.status).toBe(200);
    expect(await terminalDiscovery.json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
      resource: expect.objectContaining({
        scope: expect.objectContaining({ id: terminalScopeId, kind: "terminal", role: "viewer" }),
        terminal: expect.objectContaining({ id: "terminal_release", status: "active" }),
      }),
    })]) });

    await runtime.repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000003",
      scopeId: projectScopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "project",
      authorityGeneration: 2,
      metadataRevision: 1,
      recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "accepted" }],
    });
    await runtime.repository.setPolicy({
      milestone: "m4",
      expectedRevision: 0,
      mode: "enabled",
      cohort: [],
      changedBy: "operator_test",
    });
    const projectDiscovery = await app.request("/api/collaboration/shared", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(projectDiscovery.status).toBe(200);
    expect(await projectDiscovery.json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
      resource: expect.objectContaining({
        scope: expect.objectContaining({ id: projectScopeId, kind: "project", role: "editor" }),
        project: expect.objectContaining({ id: "proj_alpha", status: "active" }),
      }),
    })]) });
    await runtime.shutdown();
  });
});
