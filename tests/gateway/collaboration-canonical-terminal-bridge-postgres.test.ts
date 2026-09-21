import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
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
    expect(runtime.writeInput).toHaveBeenCalledWith({ workspaceId, tabId }, "echo safe");
    await expect(bridge.runtime.resize({ ...action, cols: 90, rows: 30 })).rejects.toThrow();
    await bridge.registry.unbindCollaboration(terminalId, { scopeId, sessionIncarnation: eligible.sessionIncarnation });
    await expect(bridge.runtime.input({ ...action, data: "after revoke" })).rejects.toThrow();
    expect(runtime.writeInput).toHaveBeenCalledOnce();
  });
});
