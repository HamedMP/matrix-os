import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  ProjectAppAdapterError,
  createProjectAppAdapter,
  type ProjectAppBridge,
} from "../../packages/gateway/src/collaboration/project-app-adapter.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const PROJECT_SCOPE_ID = "10000000-0000-4000-8000-000000000091";
const PROJECT_ID = "proj_alpha";
const OWNER_ID = "user_project_owner";
const EDITOR_ID = "user_project_editor";
const VIEWER_ID = "user_project_viewer";
const APP_ID = "app_board";
const RUNTIME_ID = "runtime_project_shared";
const NOW = new Date("2026-08-14T12:00:00.000Z");

describe("project collaboration app adapter", () => {
  let fixture: CollaborationTestDatabase;
  let authority: CollaborationAuthority;
  let rows: Array<Record<string, unknown>>;
  let bridge: ProjectAppBridge;
  let bridgeCalls: Array<Record<string, unknown>>;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: PROJECT_SCOPE_ID,
      owner_type: "personal",
      owner_id: OWNER_ID,
      kind: "project",
      resource_id: PROJECT_ID,
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      revision: 5,
      auth_epoch: 1,
      authority_runtime_id: RUNTIME_ID,
      authority_generation: 1,
      execution_generation: null,
      execution_eligibility: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    }).execute();
    for (const [actorId, role] of [
      [OWNER_ID, "owner"],
      [EDITOR_ID, "editor"],
      [VIEWER_ID, "viewer"],
    ] as const) {
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: PROJECT_SCOPE_ID,
        actor_id: actorId,
        role,
        status: "accepted",
        invitation_id: null,
        invited_by: OWNER_ID,
        accepted_at: NOW,
        expires_at: null,
        revision: 1,
        joined_at: NOW,
        updated_at: NOW,
      }).execute();
    }
    await fixture.db.insertInto("collaboration_resource_bindings").values({
      id: "30000000-0000-4000-8000-000000000091",
      project_scope_id: PROJECT_SCOPE_ID,
      resource_scope_id: null,
      resource_kind: "app",
      resource_id: APP_ID,
      authority_runtime_id: RUNTIME_ID,
      authority_generation: 1,
      revision: 2,
      readiness: "ready",
      blocker: null,
      incarnation: null,
      created_at: NOW,
      updated_at: NOW,
    }).execute();
    authority = new CollaborationAuthority(new CollaborationRepository(fixture.db), { now: () => NOW });
    rows = [];
    bridgeCalls = [];
    bridge = {
      async execute(input) {
        bridgeCalls.push({
          namespace: input.namespace,
          scopeId: input.scopeId,
          actorId: input.actorId,
          action: input.action,
          transactional: input.transaction !== undefined,
        });
        if (input.action.action === "insert") {
          const row = { id: `row_${rows.length + 1}`, ...input.action.data };
          rows.push(row);
          return { id: row.id };
        }
        if (input.action.action === "find") return [...rows];
        throw new Error("unsupported test action");
      },
    };
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  function adapter(mode: "scoped" | "unavailable" = "scoped") {
    return createProjectAppAdapter({
      db: fixture.db,
      authority,
      bridge,
      apps: {
        resolve: vi.fn(async (projectId, appId) => projectId === PROJECT_ID && appId === APP_ID
          ? { projectId, appId, bridgeAppId: "board", collaborationMode: mode }
          : null),
      },
      now: () => NOW,
      createEventId: () => "40000000-0000-4000-8000-000000000091",
    });
  }

  it("shares one project-scoped app-data namespace without using personal app data", async () => {
    const projectApps = adapter();
    const editor = await authority.authorize({
      scopeId: PROJECT_SCOPE_ID,
      actorId: EDITOR_ID,
      action: "mutate_project",
    });
    const owner = await authority.authorize({
      scopeId: PROJECT_SCOPE_ID,
      actorId: OWNER_ID,
      action: "read",
    });

    await expect(projectApps.mutate(editor, {
      appId: APP_ID,
      clientRequestId: "50000000-0000-4000-8000-000000000091",
      expectedRevision: 2,
      action: { app: "board", table: "cards", action: "insert", data: { title: "Shared" } },
    })).resolves.toEqual({ result: { id: "row_1" }, revision: 3, replayed: false });
    await expect(projectApps.query(owner, {
      appId: APP_ID,
      action: { app: "board", table: "cards", action: "find" },
    })).resolves.toEqual([{ id: "row_1", title: "Shared" }]);

    expect(bridgeCalls).toHaveLength(2);
    expect(bridgeCalls[0]?.namespace).toEqual(bridgeCalls[1]?.namespace);
    expect(bridgeCalls[0]?.namespace).not.toBe("board");
    expect(bridgeCalls[0]?.namespace).toMatch(/^p[a-f0-9]{32}$/);
    expect(bridgeCalls.every((call) => call.transactional === true)).toBe(true);
  });

  it("keeps viewer access read-only at the adapter boundary", async () => {
    const viewer = await authority.authorize({
      scopeId: PROJECT_SCOPE_ID,
      actorId: VIEWER_ID,
      action: "read",
    });
    await expect(adapter().query(viewer, {
      appId: APP_ID,
      action: { app: "board", table: "cards", action: "find" },
    })).resolves.toEqual([]);
    await expect(adapter().mutate(viewer, {
      appId: APP_ID,
      clientRequestId: "50000000-0000-4000-8000-000000000092",
      expectedRevision: 2,
      action: { app: "board", table: "cards", action: "insert", data: { title: "Denied" } },
    })).rejects.toMatchObject({ code: "forbidden" });
    expect(rows).toEqual([]);
  });

  it("rejects owner credentials and cannot route an action to another app", async () => {
    const editor = await authority.authorize({
      scopeId: PROJECT_SCOPE_ID,
      actorId: EDITOR_ID,
      action: "mutate_project",
    });
    await expect(adapter().mutate(editor, {
      appId: APP_ID,
      clientRequestId: "50000000-0000-4000-8000-000000000093",
      expectedRevision: 2,
      action: {
        app: "board",
        table: "cards",
        action: "insert",
        data: { title: "Denied" },
        credential: "private-owner-secret",
      },
    })).rejects.toMatchObject({ code: "invalid_action" });
    await expect(adapter().query(editor, {
      appId: APP_ID,
      action: { app: "other_app", table: "cards", action: "find" },
    })).rejects.toMatchObject({ code: "invalid_action" });
    expect(JSON.stringify(bridgeCalls)).not.toContain("private-owner-secret");
  });

  it("fails closed when an app cannot enforce scoped bridge behavior", async () => {
    const owner = await authority.authorize({
      scopeId: PROJECT_SCOPE_ID,
      actorId: OWNER_ID,
      action: "read",
    });
    await expect(adapter("unavailable").query(owner, {
      appId: APP_ID,
      action: { app: "board", table: "cards", action: "find" },
    })).rejects.toMatchObject({ code: "app_unavailable" });
    expect(bridgeCalls).toEqual([]);
  });

  it("reauthorizes mutations and replays the same actor request exactly once", async () => {
    const projectApps = adapter();
    const editor = await authority.authorize({
      scopeId: PROJECT_SCOPE_ID,
      actorId: EDITOR_ID,
      action: "mutate_project",
    });
    const input = {
      appId: APP_ID,
      clientRequestId: "50000000-0000-4000-8000-000000000094",
      expectedRevision: 2,
      action: { app: "board", table: "cards", action: "insert" as const, data: { title: "Once" } },
    };
    const first = await projectApps.mutate(editor, input);
    await expect(projectApps.mutate(editor, input)).resolves.toEqual({ ...first, replayed: true });
    expect(rows).toHaveLength(1);

    const stale = await authority.authorize({
      scopeId: PROJECT_SCOPE_ID,
      actorId: VIEWER_ID,
      action: "read",
    });
    await fixture.db.updateTable("collaboration_members").set({ status: "revoked", revision: 2 })
      .where("scope_id", "=", PROJECT_SCOPE_ID).where("actor_id", "=", VIEWER_ID).execute();
    await expect(projectApps.query(stale, {
      appId: APP_ID,
      action: { app: "board", table: "cards", action: "find" },
    })).rejects.toMatchObject({ code: "not_found" });
    await expect(projectApps.mutate(stale, {
      appId: APP_ID,
      clientRequestId: "50000000-0000-4000-8000-000000000095",
      expectedRevision: 3,
      action: { app: "board", table: "cards", action: "insert", data: { title: "Denied" } },
    })).rejects.toBeInstanceOf(ProjectAppAdapterError);
    expect(rows).toHaveLength(1);
  });
});
