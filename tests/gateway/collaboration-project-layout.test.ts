import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CanvasRepository, type CanvasDatabase } from "../../packages/gateway/src/canvas/repository.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  ProjectLayoutAdapterError,
  createProjectLayoutAdapter,
  type ProjectLayoutDatabase,
} from "../../packages/gateway/src/collaboration/project-layout-adapter.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const PROJECT_SCOPE_ID = "10000000-0000-4000-8000-000000000101";
const PROJECT_ID = "proj_alpha";
const CANVAS_ID = "cnv_project_alpha_12345678";
const OWNER_ID = "user_project_owner";
const EDITOR_ID = "user_project_editor";
const VIEWER_ID = "user_project_viewer";
const RUNTIME_ID = "runtime_project_shared";
const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("project collaboration layout adapter", () => {
  let fixture: CollaborationTestDatabase;
  let authority: CollaborationAuthority;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await new CanvasRepository(fixture.db as unknown as Kysely<CanvasDatabase>).bootstrap();
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
      id: "30000000-0000-4000-8000-000000000101",
      project_scope_id: PROJECT_SCOPE_ID,
      resource_scope_id: null,
      resource_kind: "layout",
      resource_id: CANVAS_ID,
      authority_runtime_id: RUNTIME_ID,
      authority_generation: 1,
      revision: 3,
      readiness: "ready",
      blocker: null,
      incarnation: null,
      created_at: NOW,
      updated_at: NOW,
    }).execute();
    const db = fixture.db as unknown as Kysely<ProjectLayoutDatabase>;
    await db.insertInto("canvas_documents").values({
      id: CANVAS_ID,
      owner_scope: "personal",
      owner_id: OWNER_ID,
      scope_type: "project",
      scope_ref: JSON.stringify({ projectId: PROJECT_ID }) as unknown as object,
      title: "Project Alpha",
      revision: 7,
      schema_version: 1,
      nodes: JSON.stringify([
        { id: "node_app", type: "app_window", position: { x: 10, y: 20 }, size: { width: 320, height: 240 }, zIndex: 0, collapsed: false, displayState: "normal", sourceRef: { kind: "app_window", id: "app_board", projectId: PROJECT_ID }, metadata: {} },
        { id: "node_chat", type: "custom", position: { x: 400, y: 20 }, size: { width: 320, height: 240 }, zIndex: 1, collapsed: false, displayState: "normal", sourceRef: null, metadata: { customType: "chat", customVersion: 1 } },
      ]) as unknown as object,
      edges: JSON.stringify([]) as unknown as object,
      view_states: JSON.stringify([{ userId: OWNER_ID, viewport: { x: 999, y: 999, zoom: 4 }, selection: ["node_app"] }]) as unknown as object,
      display_options: JSON.stringify({ layout: "project" }) as unknown as object,
      deleted_at: null,
      created_at: NOW,
      updated_at: NOW,
    }).execute();
    authority = new CollaborationAuthority(new CollaborationRepository(fixture.db), { now: () => NOW });
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  function adapter() {
    let sequence = 101;
    return createProjectLayoutAdapter({
      db: fixture.db as unknown as Kysely<ProjectLayoutDatabase>,
      authority,
      now: () => NOW,
      createEventId: () => `40000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    });
  }

  async function context(actorId: string, action: "read" | "mutate_project" = "read") {
    return authority.authorize({ scopeId: PROJECT_SCOPE_ID, actorId, action });
  }

  it("returns common layout without leaking another member's embedded view state", async () => {
    const projectLayout = adapter();
    const owner = await projectLayout.get(await context(OWNER_ID), { canvasId: CANVAS_ID });
    const editor = await projectLayout.get(await context(EDITOR_ID), { canvasId: CANVAS_ID });

    expect(owner.layout.nodes).toEqual(editor.layout.nodes);
    expect(owner.layout).not.toHaveProperty("viewStates");
    expect(owner.viewState).toBeNull();
    expect(editor.viewState).toBeNull();
    expect(JSON.stringify(editor)).not.toContain("999");
  });

  it("updates separate nodes with targeted revisions without losing either change", async () => {
    const projectLayout = adapter();
    const editor = await context(EDITOR_ID, "mutate_project");
    await expect(projectLayout.patchNode(editor, {
      canvasId: CANVAS_ID,
      nodeId: "node_app",
      expectedNodeRevision: 0,
      clientRequestId: "50000000-0000-4000-8000-000000000101",
      updates: { position: { x: 80, y: 90 } },
    })).resolves.toMatchObject({ nodeRevision: 1, layoutRevision: 8, replayed: false });
    await expect(projectLayout.patchNode(editor, {
      canvasId: CANVAS_ID,
      nodeId: "node_chat",
      expectedNodeRevision: 0,
      clientRequestId: "50000000-0000-4000-8000-000000000102",
      updates: { position: { x: 500, y: 100 } },
    })).resolves.toMatchObject({ nodeRevision: 1, layoutRevision: 9, replayed: false });

    const current = await projectLayout.get(await context(OWNER_ID), { canvasId: CANVAS_ID });
    expect(current.layout.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "node_app", position: { x: 80, y: 90 } }),
      expect.objectContaining({ id: "node_chat", position: { x: 500, y: 100 } }),
    ]));
  });

  it("rejects stale same-node writes and keeps viewer layout mutation read-only", async () => {
    const projectLayout = adapter();
    const editor = await context(EDITOR_ID, "mutate_project");
    const mutation = {
      canvasId: CANVAS_ID,
      nodeId: "node_app",
      expectedNodeRevision: 0,
      clientRequestId: "50000000-0000-4000-8000-000000000103",
      updates: { position: { x: 80, y: 90 } },
    };
    await projectLayout.patchNode(editor, mutation);
    await expect(projectLayout.patchNode(editor, {
      ...mutation,
      clientRequestId: "50000000-0000-4000-8000-000000000104",
      updates: { position: { x: 100, y: 120 } },
    })).rejects.toMatchObject({ code: "conflict" });

    await expect(projectLayout.patchNode(await context(VIEWER_ID), {
      ...mutation,
      clientRequestId: "50000000-0000-4000-8000-000000000105",
      expectedNodeRevision: 1,
    })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("stores viewport, selection, and focus only for the current member", async () => {
    const projectLayout = adapter();
    const editorState = {
      viewport: { x: 20, y: 30, zoom: 1.5 },
      selection: ["node_app"],
      focusedNodeId: "node_app",
      filters: {},
      groups: [],
    };
    await expect(projectLayout.putViewState(await context(EDITOR_ID), {
      canvasId: CANVAS_ID,
      expectedRevision: 0,
      clientRequestId: "50000000-0000-4000-8000-000000000106",
      state: editorState,
    })).resolves.toMatchObject({ revision: 1, replayed: false });
    await projectLayout.putViewState(await context(VIEWER_ID), {
      canvasId: CANVAS_ID,
      expectedRevision: 0,
      clientRequestId: "50000000-0000-4000-8000-000000000107",
      state: { ...editorState, viewport: { x: -40, y: 5, zoom: 0.75 }, selection: [] },
    });

    await expect(projectLayout.get(await context(EDITOR_ID), { canvasId: CANVAS_ID }))
      .resolves.toMatchObject({ viewState: { ...editorState, revision: 1 } });
    await expect(projectLayout.get(await context(VIEWER_ID), { canvasId: CANVAS_ID }))
      .resolves.toMatchObject({ viewState: { viewport: { x: -40, y: 5, zoom: 0.75 }, selection: [], revision: 1 } });
    await expect(projectLayout.get(await context(OWNER_ID), { canvasId: CANVAS_ID }))
      .resolves.toMatchObject({ viewState: null });
    await expect(projectLayout.putViewState(await context(OWNER_ID), {
      canvasId: CANVAS_ID,
      expectedRevision: 0,
      clientRequestId: "50000000-0000-4000-8000-000000000109",
      state: { ...editorState, userId: EDITOR_ID },
    })).rejects.toMatchObject({ code: "invalid" });
  });

  it("reauthorizes reads and private-state writes after revocation", async () => {
    const projectLayout = adapter();
    const stale = await context(EDITOR_ID);
    await fixture.db.updateTable("collaboration_members").set({ status: "revoked", revision: 2 })
      .where("scope_id", "=", PROJECT_SCOPE_ID).where("actor_id", "=", EDITOR_ID).execute();

    await expect(projectLayout.get(stale, { canvasId: CANVAS_ID }))
      .rejects.toBeInstanceOf(ProjectLayoutAdapterError);
    await expect(projectLayout.putViewState(stale, {
      canvasId: CANVAS_ID,
      expectedRevision: 0,
      clientRequestId: "50000000-0000-4000-8000-000000000108",
      state: { viewport: { x: 0, y: 0, zoom: 1 }, selection: [], filters: {}, groups: [] },
    })).rejects.toMatchObject({ code: "not_found" });
  });
});
