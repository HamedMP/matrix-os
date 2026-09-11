import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  CollaborationTerminalAdapter,
  CollaborationTerminalAdapterError,
} from "../../packages/gateway/src/collaboration/terminal-adapter.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = "2026-09-11T12:00:00.000Z";
const terminalId = "terminal_release";
const incarnation = `terminal-${"a".repeat(32)}`;
const confirmationSecret = "0123456789abcdef0123456789abcdef";

describe("CollaborationTerminalAdapter scope binding", () => {
  let fixture: CollaborationTestDatabase;
  let session: Record<string, unknown>;
  let registry: ReturnType<typeof registryFixture>;
  let adapter: CollaborationTerminalAdapter;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    session = eligibleSession();
    registry = registryFixture(() => session);
    adapter = new CollaborationTerminalAdapter({
      repository: new CollaborationRepository(fixture.db, { now: () => new Date(now) }),
      registry,
      runtime: runtimeFixture(),
      runtimeId: collaborationIds.runtime,
      executionEligibility: {
        profileId: "scope-runtime-terminal-v1",
        profileVersion: 1,
        profileDigest: "c".repeat(64),
        adapterId: "terminal",
        harnessVersion: "1.0.0",
      },
      preflightSecret: confirmationSecret,
      now: () => new Date(now),
      createScopeId: () => collaborationIds.scope,
    });
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("leaves an unrestricted existing terminal intact and ineligible", async () => {
    delete session.creatorActorId;
    delete session.sessionIncarnation;
    delete session.executionGeneration;
    delete session.sharedControlMode;

    await expect(adapter.preflight({
      ownerId: collaborationActors.owner,
      terminalId,
    })).resolves.toEqual({ eligible: false, reason: "unsupported", resourceRevision: 0 });
    expect(registry.bindCollaboration).not.toHaveBeenCalled();
    expect(registry.create).not.toHaveBeenCalled();
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it("activates one standalone scope for the exact running incarnation", async () => {
    const preflight = await adapter.preflight({ ownerId: collaborationActors.owner, terminalId });
    expect(preflight).toMatchObject({ eligible: true, resourceRevision: 4 });

    const scope = await adapter.shareTerminal({
      ownerId: collaborationActors.owner,
      terminalId,
      clientRequestId: "50000000-0000-4000-8000-000000000020",
      payloadHash: "a".repeat(64),
      expectedResourceRevision: 4,
      confirmationToken: preflight.confirmationToken!,
    });
    expect(scope).toMatchObject({
      id: collaborationIds.scope,
      kind: "terminal",
      resourceId: terminalId,
      lifecycle: "shared",
      revision: 1,
      authEpoch: 1,
    });
    expect(registry.bindCollaboration).toHaveBeenCalledWith(terminalId, {
      scopeId: collaborationIds.scope,
      sessionIncarnation: incarnation,
      executionGeneration: 4,
    });
    const persisted = await fixture.db.selectFrom("collaboration_scopes")
      .select(["execution_generation", "execution_eligibility"])
      .where("id", "=", collaborationIds.scope).executeTakeFirstOrThrow();
    expect(persisted).toMatchObject({
      execution_generation: 4,
      execution_eligibility: { profileId: "scope-runtime-terminal-v1" },
    });
  });

  it("rejects an incarnation change after confirmation without replacing the process", async () => {
    const preflight = await adapter.preflight({ ownerId: collaborationActors.owner, terminalId });
    session = { ...session, sessionIncarnation: `terminal-${"b".repeat(32)}` };

    await expect(adapter.shareTerminal({
      ownerId: collaborationActors.owner,
      terminalId,
      clientRequestId: "50000000-0000-4000-8000-000000000020",
      payloadHash: "a".repeat(64),
      expectedResourceRevision: 4,
      confirmationToken: preflight.confirmationToken!,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(registry.bindCollaboration).not.toHaveBeenCalled();
    expect(registry.create).not.toHaveBeenCalled();
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it("does not expose a private database orphan when registry binding fails", async () => {
    const preflight = await adapter.preflight({ ownerId: collaborationActors.owner, terminalId });
    registry.bindCollaboration.mockRejectedValueOnce(new Error("registry unavailable"));

    await expect(adapter.shareTerminal({
      ownerId: collaborationActors.owner,
      terminalId,
      clientRequestId: "50000000-0000-4000-8000-000000000020",
      payloadHash: "a".repeat(64),
      expectedResourceRevision: 4,
      confirmationToken: preflight.confirmationToken!,
    })).rejects.toBeInstanceOf(CollaborationTerminalAdapterError);
    const scope = await fixture.db.selectFrom("collaboration_scopes").select("lifecycle")
      .where("id", "=", collaborationIds.scope).executeTakeFirstOrThrow();
    expect(scope.lifecycle).toBe("private");
  });

  it("rejects a terminal already bound to another collaboration scope", async () => {
    session = {
      ...session,
      collaborationScopeId: "10000000-0000-4000-8000-000000000099",
      sharedControlMode: "shared",
    };
    await expect(adapter.preflight({
      ownerId: collaborationActors.owner,
      terminalId,
    })).resolves.toEqual({ eligible: false, reason: "unsupported", resourceRevision: 4 });
  });
});

function eligibleSession() {
  return {
    name: terminalId,
    status: "active",
    createdAt: now,
    incarnationVerified: true,
    creatorActorId: collaborationActors.owner,
    sessionIncarnation: incarnation,
    executionGeneration: 4,
    sharedControlMode: "eligible",
  };
}

function registryFixture(readSession: () => Record<string, unknown>) {
  return {
    get: vi.fn(async () => readSession()),
    create: vi.fn(async () => readSession()),
    delete: vi.fn(async () => undefined),
    bindCollaboration: vi.fn(async (_name: string, input: { scopeId: string }) => {
      sessionBinding(readSession(), input.scopeId);
      return readSession();
    }),
    unbindCollaboration: vi.fn(async () => undefined),
  };
}

function sessionBinding(value: Record<string, unknown>, scopeId: string) {
  value.collaborationScopeId = scopeId;
  value.sharedControlMode = "shared";
}

function runtimeFixture() {
  return {
    input: vi.fn(async () => undefined),
    paste: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}
