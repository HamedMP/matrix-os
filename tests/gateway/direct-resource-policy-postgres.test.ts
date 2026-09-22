/**
 * S12 / T060: direct resource adapters enforce the two V1 presets on the home.
 *
 * Runs against a dedicated PostgreSQL server when MATRIX_TEST_POSTGRES_URL is
 * set (races) and against the PGlite fixture otherwise. Paths are never
 * identities: every file, folder and app instance is addressed by its catalog
 * id, and a standalone share grants exactly that resource.
 */
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COLLABORATION_DIRECT_ROUTES } from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { createAppInstanceAdapter } from "../../packages/gateway/src/collaboration/app-instance-adapter.js";
import { CollaborationCapabilityRepository } from "../../packages/gateway/src/collaboration/capability-repository.js";
import { CollaborationCapabilityEvaluator } from "../../packages/gateway/src/collaboration/capability-evaluator.js";
import { CollaborationChatAdapter } from "../../packages/gateway/src/collaboration/chat-adapter.js";
import { CollaborationChatScopeService } from "../../packages/gateway/src/collaboration/chat-scope.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationDiscussionAdapter } from "../../packages/gateway/src/collaboration/discussion-adapter.js";
import { registerChatRoutes } from "../../packages/gateway/src/collaboration/chat-routes.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import {
  CollaborationResourceCatalog,
  ResourceCatalogError,
} from "../../packages/gateway/src/collaboration/resource-catalog.js";
import {
  registerResourceRoutes,
  type CollaborationResourceDriver,
} from "../../packages/gateway/src/collaboration/resource-routes.js";
import { registerTerminalRoutes } from "../../packages/gateway/src/collaboration/terminal-routes.js";
import { createCollaborationUploadStager } from "../../packages/gateway/src/collaboration/upload-stages.js";
import type { CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/route-support.js";
import type { ProjectAppBridge } from "../../packages/gateway/src/collaboration/project-app-adapter.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import {
  allowAllOrganizationPrecondition,
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const NOW = new Date("2026-09-21T09:00:00.000Z");
const KEY = "0123456789abcdef0123456789abcdef";
const ORG = "org_collaboration_primary";
const PROJECT_ID = "proj_alpha";
const APP_ID = "app_board";
const PROJECT_SCOPE = "10000000-0000-4000-8000-000000000501";
const FILE_SCOPE = "10000000-0000-4000-8000-000000000502";
const FOLDER_SCOPE = "10000000-0000-4000-8000-000000000503";
const APP_SCOPE = "10000000-0000-4000-8000-000000000504";
const CHAT_SCOPE = "10000000-0000-4000-8000-000000000505";
const TERMINAL_SCOPE = "10000000-0000-4000-8000-000000000506";
const hasRealPostgres = Boolean(process.env.MATRIX_TEST_POSTGRES_URL);

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `9${String(requestCounter).padStart(7, "0")}-0000-4000-8000-000000000000`;
}

class MemoryDriver implements CollaborationResourceDriver {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  readonly assets = new Map<string, Uint8Array>();
  private key(input: { ownerId: string; projectId: string | null; path: string }): string {
    return `${input.ownerId}:${input.projectId ?? "-"}:${input.path}`;
  }
  async read(input: { ownerId: string; projectId: string | null; path: string }) {
    const bytes = this.files.get(this.key(input));
    if (!bytes) throw new ResourceCatalogError("not_found");
    return { size: bytes.byteLength, contentType: "application/octet-stream", stream: new Blob([bytes]).stream() };
  }
  /** Contiguous buffers handed to the driver for the last write, in order. */
  readonly writeChunkSizes = new Map<string, number[]>();
  async write(input: { ownerId: string; projectId: string | null; path: string; content: Uint8Array }) {
    this.writeChunkSizes.set(this.key(input), [input.content.byteLength]);
    this.files.set(this.key(input), input.content);
  }
  async writeChunks(input: {
    ownerId: string; projectId: string | null; path: string; size: number; sha256: string;
    chunks: AsyncIterable<Uint8Array>;
  }) {
    const sizes: number[] = [];
    const collected: Uint8Array[] = [];
    const digest = createHash("sha256");
    let received = 0;
    for await (const chunk of input.chunks) {
      received += chunk.byteLength;
      if (received > input.size) throw new ResourceCatalogError("invalid");
      sizes.push(chunk.byteLength);
      collected.push(chunk);
      digest.update(chunk);
    }
    // The owner driver renames the temp file into place only after these hold.
    if (received !== input.size) throw new ResourceCatalogError("invalid");
    if (digest.digest("hex") !== input.sha256) throw new ResourceCatalogError("conflict");
    this.writeChunkSizes.set(this.key(input), sizes);
    this.files.set(this.key(input), Buffer.concat(collected));
  }
  readonly removed: Array<{ path: string; kind: "file" | "folder" }> = [];
  async remove(input: { ownerId: string; projectId: string | null; path: string; kind: "file" | "folder" }) {
    this.removed.push({ path: input.path, kind: input.kind });
    const key = this.key(input);
    this.files.delete(key);
    this.folders.delete(key);
    // The owner driver removes a folder with rm -r; a memory driver that only drops the
    // folder key would hide the bytes a rolled-back folder delete destroys.
    if (input.kind !== "folder") return;
    for (const existing of [...this.files.keys()]) if (existing.startsWith(`${key}/`)) this.files.delete(existing);
    for (const existing of [...this.folders]) if (existing.startsWith(`${key}/`)) this.folders.delete(existing);
  }
  async rename(input: { ownerId: string; projectId: string | null; from: string; to: string }) {
    const from = this.key({ ...input, path: input.from });
    const to = this.key({ ...input, path: input.to });
    const bytes = this.files.get(from);
    if (bytes) { this.files.delete(from); this.files.set(to, bytes); }
    if (this.folders.has(from)) { this.folders.delete(from); this.folders.add(to); }
  }
  async mkdir(input: { ownerId: string; projectId: string | null; path: string }) {
    this.folders.add(this.key(input));
  }
  async fingerprint(input: { ownerId: string; projectId: string | null; path: string }) {
    return `fp-${this.key(input)}`;
  }
  async readAppAsset(input: { ownerId: string; projectId: string | null; appId: string; assetPath: string }) {
    const bytes = this.assets.get(`${input.appId}/${input.assetPath}`);
    if (!bytes) throw new ResourceCatalogError("not_found");
    return { size: bytes.byteLength, contentType: "text/javascript", stream: new Blob([bytes]).stream() };
  }
}

describe("S12 direct resource policy", () => {
  let fixture: CollaborationTestDatabase;
  let app: Hono;
  let signer: CollaborationProofSigner;
  let nonce: number;
  let repository: CollaborationRepository;
  let grants: CollaborationCapabilityRepository;
  let catalog: CollaborationResourceCatalog;
  let driver: MemoryDriver;
  let uploads: ReturnType<typeof createCollaborationUploadStager>;
  let bridgeCalls: Array<{ namespace: string; action: string; actorId: string }>;
  let terminalActions: Array<{ actorId: string; action: unknown }>;
  let ids: { readme: string; notes: string; docs: string; docsGuide: string; app: string };

  async function seedScope(input: {
    id: string;
    kind: "chat" | "terminal" | "project" | "file" | "folder" | "app";
    resourceId: string;
    executionEligibility?: unknown;
  }): Promise<void> {
    await fixture.db.insertInto("collaboration_scopes").values({
      id: input.id,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      organization_id: ORG,
      kind: input.kind,
      resource_id: input.resourceId,
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      revision: 1,
      auth_epoch: 1,
      authority_runtime_id: collaborationIds.runtime,
      authority_generation: 1,
      execution_generation: input.executionEligibility ? 1 : null,
      execution_eligibility: input.executionEligibility ? JSON.stringify(input.executionEligibility) : null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    }).execute();
    for (const [actorId, role] of [
      [collaborationActors.owner, "owner"],
      [collaborationActors.editor, "editor"],
      [collaborationActors.viewer, "viewer"],
    ] as const) {
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: input.id,
        actor_id: actorId,
        role,
        status: "accepted",
        organization_id: ORG,
        invitation_id: null,
        invited_by: collaborationActors.owner,
        accepted_at: NOW,
        revision: 1,
        expires_at: null,
        joined_at: NOW,
        updated_at: NOW,
      }).execute();
    }
  }

  async function signed(input: {
    actorId: string;
    scopeId: string;
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    query?: string;
    body?: unknown;
  }): Promise<Response> {
    const bytes = input.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(input.body));
    const proof = signer.signHttp({
      actorId: input.actorId,
      ownerId: collaborationActors.owner,
      runtimeId: collaborationIds.runtime,
      scopeId: input.scopeId,
      method: input.method,
      path: input.path,
      query: input.query ?? "",
      body: bytes,
    });
    return app.request(`${input.path}${input.query ? `?${input.query}` : ""}`, {
      method: input.method,
      headers: {
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
  }

  beforeEach(async () => {
    requestCounter = 0;
    fixture = hasRealPostgres ? await createRealCollaborationTestDatabase() : await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("chats").values({
      id: collaborationIds.chat,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      create_request_id: "request_resource_chat",
      project_id: null,
      title: "Standalone chat",
      lifecycle: "active",
      attention: "none",
      revision: 1,
      collaboration: JSON.stringify({ scopeId: CHAT_SCOPE, mode: "discussion_only", executionFenced: true }),
      user_state: null,
      shell_state: null,
      fork_provenance: null,
      last_message_preview: null,
      current_selection: JSON.stringify({ instanceId: "claude_code_default", model: "opus" }),
      bound_driver_kind: null,
      bound_instance_id: null,
      bound_at_turn_id: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    }).execute();
    repository = new CollaborationRepository(fixture.db, { now: () => NOW, createId: () => collaborationIds.invitation });
    grants = new CollaborationCapabilityRepository(fixture.db, { now: () => NOW, createId: randomUUID });
    const authority = new CollaborationAuthority(repository, {
      now: () => NOW,
      organizationPrecondition: allowAllOrganizationPrecondition,
      capabilities: grants,
    });
    const evaluator = new CollaborationCapabilityEvaluator({
      db: fixture.db, grants, organizationPrecondition: allowAllOrganizationPrecondition, now: () => NOW,
    });
    void evaluator;
    // A small descendant bound keeps the over-bound folder delete cheap to prove.
    catalog = new CollaborationResourceCatalog(fixture.db, { now: () => NOW, maxFolderDescendants: 2 });
    driver = new MemoryDriver();
    bridgeCalls = [];
    terminalActions = [];
    const bridge: ProjectAppBridge = {
      execute: async (input) => {
        bridgeCalls.push({ namespace: input.namespace, action: input.action.action, actorId: input.actorId });
        return { rows: [] };
      },
    };
    // Owner-home files: a project with two files and a docs folder, plus a standalone home note.
    const owner = collaborationActors.owner;
    const readme = await catalog.register({ ownerId: owner, projectId: PROJECT_ID, kind: "file", path: "README.md", incarnation: "inc-readme-1" });
    const docs = await catalog.register({ ownerId: owner, projectId: PROJECT_ID, kind: "folder", path: "docs", incarnation: "inc-docs-1" });
    const docsGuide = await catalog.register({ ownerId: owner, projectId: PROJECT_ID, kind: "file", path: "docs/guide.md", incarnation: "inc-guide-1" });
    const notes = await catalog.register({ ownerId: owner, projectId: null, kind: "file", path: "notes/today.md", incarnation: "inc-notes-1" });
    const appEntry = await catalog.register({ ownerId: owner, projectId: PROJECT_ID, kind: "app", path: APP_ID, incarnation: "inc-app-1" });
    ids = { readme: readme.id, notes: notes.id, docs: docs.id, docsGuide: docsGuide.id, app: appEntry.id };
    driver.files.set(`${owner}:${PROJECT_ID}:README.md`, new TextEncoder().encode("# Alpha"));
    driver.files.set(`${owner}:${PROJECT_ID}:docs/guide.md`, new TextEncoder().encode("guide"));
    driver.files.set(`${owner}:-:notes/today.md`, new TextEncoder().encode("today"));
    driver.folders.add(`${owner}:${PROJECT_ID}:docs`);
    driver.assets.set(`${APP_ID}/main.js`, new TextEncoder().encode("console.log(1)"));

    await seedScope({ id: PROJECT_SCOPE, kind: "project", resourceId: PROJECT_ID });
    await seedScope({ id: FILE_SCOPE, kind: "file", resourceId: notes.id });
    await seedScope({ id: FOLDER_SCOPE, kind: "folder", resourceId: docs.id });
    await seedScope({ id: APP_SCOPE, kind: "app", resourceId: appEntry.id });
    await seedScope({ id: CHAT_SCOPE, kind: "chat", resourceId: collaborationIds.chat });
    await seedScope({ id: TERMINAL_SCOPE, kind: "terminal", resourceId: "terminal_release", executionEligibility: { enabled: true } });
    await fixture.db.insertInto("collaboration_resource_bindings").values({
      id: "20000000-0000-4000-8000-000000000501",
      project_scope_id: PROJECT_SCOPE,
      resource_scope_id: null,
      resource_kind: "app",
      resource_id: APP_ID,
      authority_runtime_id: collaborationIds.runtime,
      authority_generation: 1,
      revision: 0,
      readiness: "ready",
      blocker: null,
      incarnation: null,
      created_at: NOW,
      updated_at: NOW,
    }).execute();

    const resolveParticipant = async (actorId: string) => ({ actorId, displayName: actorId });
    const chatAdapter = new CollaborationChatAdapter({ db: fixture.db, authority, resolveParticipant, now: () => NOW });
    const discussionAdapter = new CollaborationDiscussionAdapter({ db: fixture.db, authority, chatAdapter, resolveParticipant, now: () => NOW });
    const chatScope = new CollaborationChatScopeService(fixture.db, {
      runtimeId: collaborationIds.runtime, preflightSecret: KEY, now: () => NOW, createScopeId: () => collaborationIds.scope,
    });
    nonce = 0;
    signer = new CollaborationProofSigner({
      activeKeyId: "collaboration-key-1",
      keys: { "collaboration-key-1": KEY },
      now: () => NOW,
      createNonce: () => (++nonce).toString(16).padStart(32, "0"),
    });
    const apps = createAppInstanceAdapter({
      db: fixture.db,
      authority,
      bridge,
      catalog,
      apps: { resolve: async (projectId, appId) => projectId === PROJECT_ID && appId === APP_ID
        ? { projectId: PROJECT_ID, appId: APP_ID, bridgeAppId: "board", collaborationMode: "scoped" }
        : null },
      now: () => NOW,
    });
    uploads = createCollaborationUploadStager({ db: fixture.db, catalog, driver, now: () => NOW });
    const options: CollaborationRouteOptions = {
      runtimeId: collaborationIds.runtime,
      verifier: new CollaborationActorProofVerifier({
        runtimeId: collaborationIds.runtime, keys: { "collaboration-key-1": KEY }, now: () => NOW, authority,
      }),
      authority,
      repository,
      chatScope,
      chatAdapter,
      discussionAdapter,
      terminalDispatcher: {
        read: async (context) => ({ scopeId: context.scopeId, status: "active", role: context.role }) as never,
        dispatch: async (input) => { terminalActions.push({ actorId: input.actorId, action: input.action }); return { accepted: true } as never; },
      } as never,
      resolveParticipant,
      resolveInvitationIdentifier: async () => { throw new Error("unused"); },
      resources: { catalog, driver, apps, uploads },
      now: () => NOW,
    };
    app = new Hono();
    registerChatRoutes(app, options);
    registerTerminalRoutes(app, options);
    registerResourceRoutes(app, options);
  });

  afterEach(async () => {
    uploads.close();
    await fixture.destroy();
  });

  describe("catalog identity", () => {
    it("keeps one stable id across renames and retires deleted incarnations", async () => {
      const entry = await catalog.get(ids.readme);
      expect(entry).toMatchObject({ id: ids.readme, path: "README.md", kind: "file", revision: 0 });
      const renamed = await catalog.rename({ id: ids.readme, path: "README.txt", expectedRevision: 0, incarnation: "inc-readme-2" });
      expect(renamed).toMatchObject({ id: ids.readme, path: "README.txt", revision: 1 });
      await expect(catalog.rename({ id: ids.readme, path: "README.rst", expectedRevision: 0, incarnation: "x" }))
        .rejects.toMatchObject({ code: "conflict" });
      const again = await catalog.register({ ownerId: collaborationActors.owner, projectId: PROJECT_ID, kind: "file", path: "README.txt", incarnation: "inc-readme-2" });
      expect(again.id).toBe(ids.readme);
      const removed = await catalog.remove({ id: ids.readme, expectedRevision: 1 });
      expect(removed.deletedAt).not.toBeNull();
      expect(await catalog.get(ids.readme)).toBeNull();
      const recreated = await catalog.register({ ownerId: collaborationActors.owner, projectId: PROJECT_ID, kind: "file", path: "README.txt", incarnation: "inc-readme-3" });
      expect(recreated.id).not.toBe(ids.readme);
    });
  });

  describe("project scope", () => {
    it("lets a viewer list, search and read but never write", async () => {
      const list = await signed({ actorId: collaborationActors.viewer, scopeId: PROJECT_SCOPE, method: "GET", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files` });
      expect(list.status).toBe(200);
      const entries = (await list.json() as { entries: Array<{ id: string; path: string }> }).entries;
      expect(entries.map((entry) => entry.path).sort()).toEqual(["README.md", "docs", "docs/guide.md"]);
      const search = await signed({ actorId: collaborationActors.viewer, scopeId: PROJECT_SCOPE, method: "GET", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files`, query: "query=guide" });
      expect(search.status).toBe(200);
      expect((await search.json() as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id)).toEqual([ids.docsGuide]);
      const content = await signed({ actorId: collaborationActors.viewer, scopeId: PROJECT_SCOPE, method: "GET", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/${ids.readme}/content` });
      expect(content.status).toBe(200);
      expect(content.headers.get("content-disposition")).toContain("attachment");
      expect(content.headers.get("cache-control")).toContain("no-store");
      expect(await content.text()).toBe("# Alpha");
      const write = await signed({ actorId: collaborationActors.viewer, scopeId: PROJECT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`, body: { type: "write", fileId: ids.readme, content: "nope", expectedRevision: "0", clientRequestId: requestId() } });
      expect(write.status).toBe(403);
      expect(driver.files.get(`${collaborationActors.owner}:${PROJECT_ID}:README.md`)).toEqual(new TextEncoder().encode("# Alpha"));
    });

    it("lets a contributor write with fresh revision checks and replays idempotently", async () => {
      const clientRequestId = requestId();
      const body = { type: "write", fileId: ids.readme, content: "# Alpha v2", expectedRevision: "0", clientRequestId };
      const first = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`, body });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ entry: { id: ids.readme, revision: "1" }, replayed: false });
      const replay = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`, body });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ entry: { id: ids.readme, revision: "1" }, replayed: true });
      const stale = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`, body: { ...body, clientRequestId: requestId(), content: "stale" } });
      expect(stale.status).toBe(409);
      expect(new TextDecoder().decode(driver.files.get(`${collaborationActors.owner}:${PROJECT_ID}:README.md`))).toBe("# Alpha v2");
    });

    it("follows a renamed id and refuses a deleted incarnation", async () => {
      const renamed = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`, body: { type: "rename", fileId: ids.readme, path: "README.txt", expectedRevision: "0", clientRequestId: requestId() } });
      expect(renamed.status).toBe(200);
      const content = await signed({ actorId: collaborationActors.viewer, scopeId: PROJECT_SCOPE, method: "GET", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/${ids.readme}/content` });
      expect(await content.text()).toBe("# Alpha");
      const deleted = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`, body: { type: "delete", fileId: ids.readme, expectedRevision: "1", clientRequestId: requestId() } });
      expect(deleted.status).toBe(200);
      const gone = await signed({ actorId: collaborationActors.viewer, scopeId: PROJECT_SCOPE, method: "GET", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/${ids.readme}/content` });
      expect(gone.status).toBe(404);
    });

    it("never resolves a catalog id that belongs to another namespace", async () => {
      const foreign = await signed({ actorId: collaborationActors.owner, scopeId: PROJECT_SCOPE, method: "GET", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/${ids.notes}/content` });
      expect(foreign.status).toBe(404);
    });
  });

  describe("standalone file and folder shares", () => {
    it("grants only the shared file", async () => {
      const list = await signed({ actorId: collaborationActors.viewer, scopeId: FILE_SCOPE, method: "GET", path: `/api/collaboration/scopes/${FILE_SCOPE}/files` });
      expect((await list.json() as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id)).toEqual([ids.notes]);
      const content = await signed({ actorId: collaborationActors.viewer, scopeId: FILE_SCOPE, method: "GET", path: `/api/collaboration/scopes/${FILE_SCOPE}/files/${ids.notes}/content` });
      expect(await content.text()).toBe("today");
      const other = await signed({ actorId: collaborationActors.viewer, scopeId: FILE_SCOPE, method: "GET", path: `/api/collaboration/scopes/${FILE_SCOPE}/files/${ids.readme}/content` });
      expect(other.status).toBe(404);
      const viewerWrite = await signed({ actorId: collaborationActors.viewer, scopeId: FILE_SCOPE, method: "POST", path: `/api/collaboration/scopes/${FILE_SCOPE}/files/actions`, body: { type: "write", fileId: ids.notes, content: "x", expectedRevision: "0", clientRequestId: requestId() } });
      expect(viewerWrite.status).toBe(403);
      const editorWrite = await signed({ actorId: collaborationActors.editor, scopeId: FILE_SCOPE, method: "POST", path: `/api/collaboration/scopes/${FILE_SCOPE}/files/actions`, body: { type: "write", fileId: ids.notes, content: "tomorrow", expectedRevision: "0", clientRequestId: requestId() } });
      expect(editorWrite.status).toBe(200);
      const create = await signed({ actorId: collaborationActors.editor, scopeId: FILE_SCOPE, method: "POST", path: `/api/collaboration/scopes/${FILE_SCOPE}/files/actions`, body: { type: "create", kind: "file", parentId: null, path: "notes/other.md", content: "no", clientRequestId: requestId() } });
      expect(create.status).toBe(403);
    });

    it("grants a folder with its contents and nothing beside it", async () => {
      const list = await signed({ actorId: collaborationActors.viewer, scopeId: FOLDER_SCOPE, method: "GET", path: `/api/collaboration/scopes/${FOLDER_SCOPE}/files` });
      expect((await list.json() as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id).sort()).toEqual([ids.docs, ids.docsGuide].sort());
      const sibling = await signed({ actorId: collaborationActors.viewer, scopeId: FOLDER_SCOPE, method: "GET", path: `/api/collaboration/scopes/${FOLDER_SCOPE}/files/${ids.readme}/content` });
      expect(sibling.status).toBe(404);
      const inside = await signed({ actorId: collaborationActors.editor, scopeId: FOLDER_SCOPE, method: "POST", path: `/api/collaboration/scopes/${FOLDER_SCOPE}/files/actions`, body: { type: "create", kind: "file", parentId: ids.docs, path: "docs/faq.md", content: "faq", clientRequestId: requestId() } });
      expect(inside.status).toBe(201);
      expect(driver.files.has(`${collaborationActors.owner}:${PROJECT_ID}:docs/faq.md`)).toBe(true);
      const outside = await signed({ actorId: collaborationActors.editor, scopeId: FOLDER_SCOPE, method: "POST", path: `/api/collaboration/scopes/${FOLDER_SCOPE}/files/actions`, body: { type: "create", kind: "file", parentId: null, path: "escape.md", content: "no", clientRequestId: requestId() } });
      expect(outside.status).toBe(404);
      const traversal = await signed({ actorId: collaborationActors.editor, scopeId: FOLDER_SCOPE, method: "POST", path: `/api/collaboration/scopes/${FOLDER_SCOPE}/files/actions`, body: { type: "create", kind: "file", parentId: ids.docs, path: "docs/../escape.md", content: "no", clientRequestId: requestId() } });
      expect(traversal.status).toBe(400);
    });
  });

  describe("folder delete bounds", () => {
    it("refuses a folder over the descendant bound before it removes any bytes", async () => {
      const owner = collaborationActors.owner;
      for (const name of ["a.md", "b.md", "c.md"]) {
        await catalog.register({ ownerId: owner, projectId: PROJECT_ID, kind: "file", path: `docs/${name}`, incarnation: `inc-${name}` });
        driver.files.set(`${owner}:${PROJECT_ID}:docs/${name}`, new TextEncoder().encode(name));
      }
      const response = await signed({
        actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST",
        path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`,
        body: { type: "delete", fileId: ids.docs, expectedRevision: "0", clientRequestId: requestId() },
      });
      expect(response.status).toBe(409);
      // The conflict is a database rollback; a filesystem delete before it cannot be undone.
      expect(driver.removed).toEqual([]);
      expect(driver.files.has(`${owner}:${PROJECT_ID}:docs/guide.md`)).toBe(true);
      expect(driver.files.has(`${owner}:${PROJECT_ID}:docs/a.md`)).toBe(true);
      expect(await catalog.get(ids.docs)).not.toBeNull();
      expect(await catalog.get(ids.docsGuide)).not.toBeNull();
    });
  });

  describe("standalone app instance share", () => {
    it("serves reads and assets to a viewer and refuses mutations through the bridge", async () => {
      const instance = await signed({ actorId: collaborationActors.viewer, scopeId: APP_SCOPE, method: "GET", path: `/api/collaboration/scopes/${APP_SCOPE}/apps/${APP_ID}` });
      expect(instance.status).toBe(200);
      expect(await instance.json()).toMatchObject({ appId: APP_ID, catalogId: ids.app, revision: "0", readiness: "ready" });
      const asset = await signed({ actorId: collaborationActors.viewer, scopeId: APP_SCOPE, method: "GET", path: `/api/collaboration/scopes/${APP_SCOPE}/apps/${APP_ID}/assets/main.js` });
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      const view = await signed({ actorId: collaborationActors.viewer, scopeId: APP_SCOPE, method: "POST", path: `/api/collaboration/scopes/${APP_SCOPE}/apps/${APP_ID}/view`, body: { action: { action: "find", app: "board", table: "cards" } } });
      expect(view.status).toBe(200);
      expect(bridgeCalls).toHaveLength(1);
      expect(bridgeCalls[0]!.namespace).not.toContain(APP_ID);
      const viewerMutation = await signed({ actorId: collaborationActors.viewer, scopeId: APP_SCOPE, method: "POST", path: `/api/collaboration/scopes/${APP_SCOPE}/apps/${APP_ID}/actions`, body: { clientRequestId: requestId(), expectedRevision: "0", action: { action: "insert", app: "board", table: "cards", data: { title: "x" } } } });
      expect(viewerMutation.status).toBe(403);
      expect(bridgeCalls).toHaveLength(1);
      const viaView = await signed({ actorId: collaborationActors.viewer, scopeId: APP_SCOPE, method: "POST", path: `/api/collaboration/scopes/${APP_SCOPE}/apps/${APP_ID}/view`, body: { action: { action: "insert", app: "board", table: "cards", data: { title: "x" } } } });
      expect(viaView.status).toBe(400);
      expect(bridgeCalls).toHaveLength(1);
      const editorMutation = await signed({ actorId: collaborationActors.editor, scopeId: APP_SCOPE, method: "POST", path: `/api/collaboration/scopes/${APP_SCOPE}/apps/${APP_ID}/actions`, body: { clientRequestId: requestId(), expectedRevision: "0", action: { action: "insert", app: "board", table: "cards", data: { title: "x" } } } });
      expect(editorMutation.status).toBe(200);
      expect(await editorMutation.json()).toMatchObject({ revision: 1, replayed: false });
      expect(bridgeCalls).toHaveLength(2);
      const otherApp = await signed({ actorId: collaborationActors.editor, scopeId: APP_SCOPE, method: "GET", path: `/api/collaboration/scopes/${APP_SCOPE}/apps/app_other` });
      expect(otherApp.status).toBe(404);
    });

    it("serves the project-bound app through the project scope with the same preset rules", async () => {
      const view = await signed({ actorId: collaborationActors.viewer, scopeId: PROJECT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/apps/${APP_ID}/view`, body: { action: { action: "count", app: "board", table: "cards" } } });
      expect(view.status).toBe(200);
      const mutation = await signed({ actorId: collaborationActors.viewer, scopeId: PROJECT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/apps/${APP_ID}/actions`, body: { clientRequestId: requestId(), expectedRevision: "0", action: { action: "delete", app: "board", table: "cards", id: "card_1" } } });
      expect(mutation.status).toBe(403);
    });
  });

  describe("standalone Chat and terminal shares", () => {
    it("lets a Chat viewer read history and discussion but not post", async () => {
      const chat = await signed({ actorId: collaborationActors.viewer, scopeId: CHAT_SCOPE, method: "GET", path: `/api/collaboration/scopes/${CHAT_SCOPE}/chat` });
      expect(chat.status).toBe(200);
      const discussion = await signed({ actorId: collaborationActors.viewer, scopeId: CHAT_SCOPE, method: "GET", path: `/api/collaboration/scopes/${CHAT_SCOPE}/discussion/messages` });
      expect(discussion.status).toBe(200);
      const post = await signed({ actorId: collaborationActors.viewer, scopeId: CHAT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${CHAT_SCOPE}/discussion/messages`, body: { clientRequestId: requestId(), expectedRevision: "1", text: "hello" } });
      expect(post.status).toBe(403);
      const contributorPost = await signed({ actorId: collaborationActors.editor, scopeId: CHAT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${CHAT_SCOPE}/discussion/messages`, body: { clientRequestId: requestId(), expectedRevision: "1", text: "hello" } });
      expect(contributorPost.status).toBe(201);
    });

    it("lets a terminal viewer observe only while a contributor may request the controller", async () => {
      const read = await signed({ actorId: collaborationActors.viewer, scopeId: TERMINAL_SCOPE, method: "GET", path: `/api/collaboration/scopes/${TERMINAL_SCOPE}/terminal` });
      expect(read.status).toBe(200);
      const request = { type: "acquire", clientRequestId: requestId(), incarnation: "terminal_release", connectionId: "connection_one" };
      const viewerControl = await signed({ actorId: collaborationActors.viewer, scopeId: TERMINAL_SCOPE, method: "POST", path: `/api/collaboration/scopes/${TERMINAL_SCOPE}/terminal/actions`, body: request });
      expect(viewerControl.status).toBe(403);
      expect(terminalActions).toHaveLength(0);
      const contributorControl = await signed({ actorId: collaborationActors.editor, scopeId: TERMINAL_SCOPE, method: "POST", path: `/api/collaboration/scopes/${TERMINAL_SCOPE}/terminal/actions`, body: { ...request, clientRequestId: requestId() } });
      expect(contributorControl.status).toBe(200);
      expect(terminalActions).toHaveLength(1);
    });
  });

  describe("whole-project presets from grants", () => {
    it("maps a contributor grant to write access and a viewer grant to read only", async () => {
      const newcomer = "user_collaboration_newcomer";
      const created = await grants.createGrant({
        scopeId: PROJECT_SCOPE, actorId: collaborationActors.owner, clientRequestId: requestId(), expectedRevision: 1, payloadHash: "a".repeat(64),
        audience: { kind: "member", actorId: newcomer }, preset: "contributor", policyVersion: "v1",
      });
      await grants.acceptGrant({ grantId: created.grantId, actorId: newcomer });
      const write = await signed({ actorId: newcomer, scopeId: PROJECT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`, body: { type: "write", fileId: ids.docsGuide, content: "by grant", expectedRevision: "0", clientRequestId: requestId() } });
      expect(write.status).toBe(200);
      const view = await signed({ actorId: newcomer, scopeId: PROJECT_SCOPE, method: "POST",
        path: `/api/collaboration/scopes/${PROJECT_SCOPE}/apps/${APP_ID}/view`,
        body: { action: { action: "count", app: "board", table: "cards" } } });
      expect(view.status).toBe(200);
      const mutate = await signed({ actorId: newcomer, scopeId: PROJECT_SCOPE, method: "POST",
        path: `/api/collaboration/scopes/${PROJECT_SCOPE}/apps/${APP_ID}/actions`,
        body: { clientRequestId: requestId(), expectedRevision: "0", action: { action: "insert", app: "board", table: "cards", data: { title: "grant" } } } });
      expect(mutate.status).toBe(200);
    });
  });

  describe.skipIf(!hasRealPostgres)("races on real Postgres", () => {
    it("lets exactly one of two concurrent writes with the same base revision commit", async () => {
      const path = `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`;
      const results = await Promise.all([1, 2].map((n) => signed({
        actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "write", fileId: ids.readme, content: `v${n}`, expectedRevision: "0", clientRequestId: requestId() },
      })));
      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(await catalog.get(ids.readme)).toMatchObject({ revision: 1 });
    });

    it("denies a write that lands after the member was revoked", async () => {
      await fixture.db.updateTable("collaboration_members").set({ status: "revoked", updated_at: NOW })
        .where("scope_id", "=", PROJECT_SCOPE).where("actor_id", "=", collaborationActors.editor).execute();
      const write = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path: `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`, body: { type: "write", fileId: ids.readme, content: "late", expectedRevision: "0", clientRequestId: requestId() } });
      expect([403, 404]).toContain(write.status);
      expect(new TextDecoder().decode(driver.files.get(`${collaborationActors.owner}:${PROJECT_ID}:README.md`))).toBe("# Alpha");
    });
  });

  describe("staged uploads", () => {
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const path = `/api/collaboration/scopes/${PROJECT_SCOPE}/files/actions`;

    it("rejects empty chunks and excessive part indexes before storing them", async () => {
      const bytes = new TextEncoder().encode("x");
      const uploadId = requestId();
      expect((await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_stage", fileId: ids.readme, size: bytes.length, sha256: hash(bytes), clientRequestId: uploadId } })).status).toBe(200);
      const part = (index: number, chunk: Uint8Array) => signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE,
        method: "POST", path, body: { type: "upload_part", uploadId, index, sha256: hash(chunk), chunk: Buffer.from(chunk).toString("base64") } });
      expect((await part(0, new Uint8Array())).status).toBe(400);
      expect((await part(8_192, bytes)).status).toBe(400);
      const parts = await fixture.db.selectFrom("collaboration_upload_parts").select("part_index").where("upload_id", "=", uploadId).execute();
      expect(parts).toEqual([]);
    });

    it("resumes immutable parts and commits only after the whole checksum matches", async () => {
      const bytes = new TextEncoder().encode("replacement through two parts");
      const first = bytes.slice(0, 12);
      const second = bytes.slice(12);
      const uploadId = requestId();
      const stage = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_stage", fileId: ids.readme, size: bytes.length, sha256: hash(bytes), clientRequestId: uploadId } });
      expect(stage.status).toBe(200);
      expect(await stage.json()).toMatchObject({ upload: { uploadId, state: "staging", receivedBytes: 0 }, replayed: false });
      const part = (index: number, chunk: Uint8Array) => signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE,
        method: "POST", path, body: { type: "upload_part", uploadId, index, sha256: hash(chunk), chunk: Buffer.from(chunk).toString("base64") } });
      expect((await part(0, first)).status).toBe(200);
      const replay = await part(0, first);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ replayed: true });
      expect((await part(1, second)).status).toBe(200);
      const commitBody = { type: "upload_commit", uploadId, expectedRevision: "0", clientRequestId: requestId() };
      const commit = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path, body: commitBody });
      expect(commit.status).toBe(201);
      expect(await commit.json()).toMatchObject({ entry: { id: ids.readme, revision: "1" }, replayed: false });
      expect(new TextDecoder().decode(driver.files.get(`${collaborationActors.owner}:${PROJECT_ID}:README.md`))).toBe(new TextDecoder().decode(bytes));
      const again = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path, body: commitBody });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ replayed: true });
    });

    it("commits staged parts as bounded chunks instead of one contiguous buffer", async () => {
      const bytes = new TextEncoder().encode("replacement through two parts");
      const first = bytes.slice(0, 12);
      const second = bytes.slice(12);
      const uploadId = requestId();
      expect((await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_stage", fileId: ids.readme, size: bytes.length, sha256: hash(bytes), clientRequestId: uploadId } })).status).toBe(200);
      const part = (index: number, chunk: Uint8Array) => signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE,
        method: "POST", path, body: { type: "upload_part", uploadId, index, sha256: hash(chunk), chunk: Buffer.from(chunk).toString("base64") } });
      expect((await part(0, first)).status).toBe(200);
      expect((await part(1, second)).status).toBe(200);
      const commit = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_commit", uploadId, expectedRevision: "0", clientRequestId: requestId() } });
      expect(commit.status).toBe(201);
      const key = `${collaborationActors.owner}:${PROJECT_ID}:README.md`;
      // One buffer per staged part, never a single buffer holding the whole upload.
      expect(driver.writeChunkSizes.get(key)).toEqual([first.byteLength, second.byteLength]);
      expect(new TextDecoder().decode(driver.files.get(key))).toBe(new TextDecoder().decode(bytes));
    });

    it("writes nothing when the staged parts do not match the declared checksum", async () => {
      const bytes = new TextEncoder().encode("declared one thing");
      const staged = new TextEncoder().encode("delivered another!");
      expect(staged.byteLength).toBe(bytes.byteLength);
      const uploadId = requestId();
      expect((await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_stage", fileId: ids.readme, size: bytes.length, sha256: hash(bytes), clientRequestId: uploadId } })).status).toBe(200);
      expect((await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_part", uploadId, index: 0, sha256: hash(staged), chunk: Buffer.from(staged).toString("base64") } })).status).toBe(200);
      const commit = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_commit", uploadId, expectedRevision: "0", clientRequestId: requestId() } });
      expect(commit.status).toBe(409);
      expect(new TextDecoder().decode(driver.files.get(`${collaborationActors.owner}:${PROJECT_ID}:README.md`))).toBe("# Alpha");
    });

    it("rejects a changed part and an incomplete commit", async () => {
      const bytes = new TextEncoder().encode("expected content");
      const uploadId = requestId();
      const stage = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_stage", fileId: ids.readme, size: bytes.length, sha256: hash(bytes), clientRequestId: uploadId } });
      expect(stage.status).toBe(200);
      const chunk = bytes.slice(0, 4);
      const partBody = { type: "upload_part", uploadId, index: 0, sha256: hash(chunk), chunk: Buffer.from(chunk).toString("base64") };
      expect((await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path, body: partBody })).status).toBe(200);
      const changed = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { ...partBody, sha256: hash(new TextEncoder().encode("oops")), chunk: Buffer.from("oops").toString("base64") } });
      expect(changed.status).toBe(409);
      const incomplete = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_commit", uploadId, expectedRevision: "0", clientRequestId: requestId() } });
      expect(incomplete.status).toBe(409);
      expect(new TextDecoder().decode(driver.files.get(`${collaborationActors.owner}:${PROJECT_ID}:README.md`))).toBe("# Alpha");
    });

    it("cancels staged bytes and sweeps expired uploads", async () => {
      const bytes = new TextEncoder().encode("temporary");
      const uploadId = requestId();
      expect((await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_stage", fileId: ids.readme, size: bytes.length, sha256: hash(bytes), clientRequestId: uploadId } })).status).toBe(200);
      const cancelled = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_cancel", uploadId } });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ upload: { state: "cancelled" } });
      const cancelledCommit = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_commit", uploadId, expectedRevision: "0", clientRequestId: requestId() } });
      expect(cancelledCommit.status).toBe(409);
      const expiringId = requestId();
      expect((await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_stage", fileId: ids.readme, size: bytes.length, sha256: hash(bytes), clientRequestId: expiringId } })).status).toBe(200);
      await fixture.db.updateTable("collaboration_upload_stages").set({ expires_at: new Date(NOW.getTime() - 1) })
        .where("id", "=", expiringId).execute();
      expect(await uploads.sweepExpired()).toBe(1);
      const expired = await fixture.db.selectFrom("collaboration_upload_stages").select("state")
        .where("id", "=", expiringId).executeTakeFirst();
      expect(expired?.state).toBe("expired");
    });

    it("denies commit after revocation even when all bytes were staged", async () => {
      const bytes = new TextEncoder().encode("blocked");
      const uploadId = requestId();
      expect((await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_stage", fileId: ids.readme, size: bytes.length, sha256: hash(bytes), clientRequestId: uploadId } })).status).toBe(200);
      expect((await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_part", uploadId, index: 0, sha256: hash(bytes), chunk: Buffer.from(bytes).toString("base64") } })).status).toBe(200);
      await fixture.db.updateTable("collaboration_members").set({ status: "revoked", updated_at: NOW })
        .where("scope_id", "=", PROJECT_SCOPE).where("actor_id", "=", collaborationActors.editor).execute();
      const commit = await signed({ actorId: collaborationActors.editor, scopeId: PROJECT_SCOPE, method: "POST", path,
        body: { type: "upload_commit", uploadId, expectedRevision: "0", clientRequestId: requestId() } });
      expect([403, 404]).toContain(commit.status);
      expect(new TextDecoder().decode(driver.files.get(`${collaborationActors.owner}:${PROJECT_ID}:README.md`))).toBe("# Alpha");
    });
  });

  describe("route table", () => {
    it("mounts every file, app, standalone Chat and terminal route from the frozen contract", () => {
      const owned = COLLABORATION_DIRECT_ROUTES.filter((route) =>
        route.path.includes("/scopes/:scopeId/files") || route.path.includes("/scopes/:scopeId/apps/")
        || ["/api/collaboration/scopes/:scopeId/chat", "/api/collaboration/scopes/:scopeId/chat/messages",
          "/api/collaboration/scopes/:scopeId/discussion/messages", "/api/collaboration/scopes/:scopeId/user-state",
          "/api/collaboration/scopes/:scopeId/terminal", "/api/collaboration/scopes/:scopeId/terminal/actions"].includes(route.path));
      expect(owned.length).toBeGreaterThanOrEqual(13);
      const mounted = new Set(app.routes.map((route) => `${route.method} ${route.path.replaceAll(/:([A-Za-z]+)\{[^}]*\}/g, ":$1")}`));
      for (const route of owned) {
        expect(mounted, `${route.method} ${route.path}`).toContain(`${route.method} ${route.path}`);
      }
    });
  });
});
