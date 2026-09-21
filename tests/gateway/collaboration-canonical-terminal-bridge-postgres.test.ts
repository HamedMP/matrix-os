import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationTerminalAdapter } from "../../packages/gateway/src/collaboration/terminal-adapter.js";
import { createCanonicalTerminalCollaborationBridge } from "../../packages/gateway/src/collaboration/canonical-terminal-bridge.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const ownerId = "user_terminal_owner";
const organizationId = "org_terminal_team";
const runtimeId = "runtime_terminal_owner";
const scopeId = "10000000-0000-4000-8000-000000000099";
const workspaceId = `tws_${"1".repeat(32)}`;
const tabId = `tt_${"2".repeat(32)}`;
const terminalId = `${workspaceId}:${tabId}`;
const createdAt = "2026-09-21T12:00:00.000Z";

describe("canonical terminal collaboration bridge", () => {
  let fixture: CollaborationTestDatabase;
  let tab: { id: string; workspaceId: string; createdAt: string; status: string; revision: number };
  let runtime: {
    listWorkspaces: ReturnType<typeof vi.fn>;
    writeInput: ReturnType<typeof vi.fn>;
    terminateTab: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    tab = { id: tabId, workspaceId, createdAt, status: "running", revision: 4 };
    runtime = {
      listWorkspaces: vi.fn(async () => [{ id: workspaceId, scope: "main", tabs: [tab] }]),
      writeInput: vi.fn(async () => undefined),
      terminateTab: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => { await fixture.destroy(); });

  it("binds only the current owner tab and persists its exact incarnation", async () => {
    const repository = new CollaborationRepository(fixture.db);
    await repository.createDirectScope({ scopeId, ownerId, organizationId, kind: "terminal", resourceId: terminalId, authorityRuntimeId: runtimeId });
    const bridge = createCanonicalTerminalCollaborationBridge({
      db: fixture.db, ownerId, runtime: runtime as never,
    });
    const eligible = await bridge.registry.get(terminalId) as { sessionIncarnation: string; executionGeneration: number; sharedControlMode: string };
    expect(eligible).toMatchObject({ sharedControlMode: "eligible", creatorActorId: ownerId, incarnationVerified: true });
    await bridge.registry.bindCollaboration(terminalId, {
      scopeId, sessionIncarnation: eligible.sessionIncarnation, executionGeneration: eligible.executionGeneration,
    });
    expect(await bridge.registry.get(terminalId)).toMatchObject({
      collaborationScopeId: scopeId, sessionIncarnation: eligible.sessionIncarnation, sharedControlMode: "shared",
    });
    const row = await fixture.db.selectFrom("collaboration_terminal_bindings")
      .select(["scope_id", "terminal_id", "tab_created_at", "incarnation"]).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ scope_id: scopeId, terminal_id: terminalId, incarnation: eligible.sessionIncarnation });
    expect(new Date(row.tab_created_at).toISOString()).toBe(createdAt);

    tab = { ...tab, createdAt: "2026-09-21T12:01:00.000Z" };
    expect(await bridge.registry.get(terminalId)).toBeNull();
    await expect(bridge.runtime.input({ terminalId, data: "secret", scopeId, incarnation: eligible.sessionIncarnation,
      actorId: ownerId, connectionId: "connection", leaseEpoch: 1, revalidate: vi.fn() })).rejects.toThrow();
    expect(runtime.writeInput).not.toHaveBeenCalled();
  });

  it("revalidates each exact-tab write and refuses workspace-wide resize", async () => {
    const repository = new CollaborationRepository(fixture.db);
    await repository.createDirectScope({ scopeId, ownerId, organizationId, kind: "terminal", resourceId: terminalId, authorityRuntimeId: runtimeId });
    const bridge = createCanonicalTerminalCollaborationBridge({ db: fixture.db, ownerId, runtime: runtime as never });
    const eligible = await bridge.registry.get(terminalId) as { sessionIncarnation: string; executionGeneration: number };
    await bridge.registry.bindCollaboration(terminalId, {
      scopeId, sessionIncarnation: eligible.sessionIncarnation, executionGeneration: eligible.executionGeneration,
    });
    const revalidate = vi.fn(async () => undefined);
    const action = { terminalId, scopeId, incarnation: eligible.sessionIncarnation, actorId: ownerId,
      connectionId: "connection", leaseEpoch: 1, revalidate };
    await bridge.runtime.input({ ...action, data: "echo safe" });
    expect(revalidate).toHaveBeenCalledOnce();
    expect(runtime.writeInput).toHaveBeenCalledWith({ workspaceId, tabId }, "echo safe", createdAt);
    await expect(bridge.runtime.resize({ ...action, cols: 90, rows: 30 })).rejects.toThrow();
    await bridge.registry.unbindCollaboration(terminalId, { scopeId, sessionIncarnation: eligible.sessionIncarnation });
    await expect(bridge.runtime.input({ ...action, data: "after revoke" })).rejects.toThrow();
    expect(runtime.writeInput).toHaveBeenCalledOnce();
  });

  it("preflights and shares the exact live tab, then refuses its stale binding", async () => {
    const repository = new CollaborationRepository(fixture.db);
    const bridge = createCanonicalTerminalCollaborationBridge({ db: fixture.db, ownerId, runtime: runtime as never });
    const adapter = new CollaborationTerminalAdapter({
      repository, registry: bridge.registry, runtime: bridge.runtime,
      runtimeId,
      executionEligibility: {
        profileId: "scope-runtime-terminal-v1", profileVersion: 1,
        profileDigest: "a".repeat(64), adapterId: "terminal", harnessVersion: "1.0.0",
      },
      preflightSecret: "0123456789abcdef0123456789abcdef",
      createScopeId: () => scopeId,
    });
    const preflight = await adapter.preflight({ ownerId, organizationId, terminalId });
    expect(preflight).toMatchObject({ eligible: true });
    const shared = await adapter.shareTerminal({
      ownerId, organizationId, terminalId, clientRequestId: "50000000-0000-4000-8000-000000000099",
      payloadHash: "b".repeat(64), expectedResourceRevision: preflight.resourceRevision,
      confirmationToken: preflight.confirmationToken!,
    });
    expect(shared).toMatchObject({ id: scopeId, resourceId: terminalId, lifecycle: "shared" });
    expect(await adapter.get(scopeId, terminalId)).toMatchObject({
      scopeId, terminalId, incarnation: expect.stringMatching(/^terminal-[a-f0-9]{32}$/),
      creatorActorId: ownerId,
    });
    tab = { ...tab, createdAt: "2026-09-21T12:01:00.000Z" };
    expect(await adapter.get(scopeId, terminalId)).toBeNull();
    const stale = await adapter.preflight({ ownerId, organizationId, terminalId });
    expect(stale.eligible).toBe(false);
  });
});
