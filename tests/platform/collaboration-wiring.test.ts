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
    expect(loadPlatformCollaborationConfig({})).toBeNull();
    expect(loadPlatformCollaborationConfig({
      MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
      MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
      MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com",
    })).toMatchObject({ activeKeyId: "key-1", enabledPurposes: ["events"] });
  });

  it("retires legacy content proxy routes while retaining metadata discovery", async () => {
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
      resolveInvitationIdentifier: async (identifier) => ({ actorId: identifier, displayName: identifier }),
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
    const app = new Hono();
    runtime.register(app);
    const response = await app.request(`/api/collaboration/scopes/${scopeId}`, {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();

    const discovery = await app.request("/api/collaboration/shared", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ items: [{ scopeId, status: "accepted", kind: "chat" }] });
    // S06 / T032: discovery is metadata-only; the platform never hydrates content from the home.
    expect(JSON.stringify(await (await app.request("/api/collaboration/shared", { headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer } })).json())).not.toMatch(/resource|Shared planning|chat_one/);

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
    const terminalDiscovery = await app.request("/api/collaboration/shared", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(terminalDiscovery.status).toBe(200);
    expect(await terminalDiscovery.json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
      scopeId: terminalScopeId, kind: "terminal", status: "accepted",
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
    const projectDiscovery = await app.request("/api/collaboration/shared", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(projectDiscovery.status).toBe(200);
    const projectPage = await projectDiscovery.json() as { items: Array<Record<string, unknown>> };
    expect(projectPage).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
      scopeId: projectScopeId, kind: "project", status: "accepted", authorityGeneration: 2,
    })]) });
    expect(projectPage.items.every((item) => !("resource" in item))).toBe(true);
    await runtime.shutdown();
  });
});
