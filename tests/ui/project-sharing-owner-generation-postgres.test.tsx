// @vitest-environment jsdom
/** Real owner sessions, home routes, grants and inventory behind the real relay; only identity/project lookup are fixtures. */
import React from "react";
import { randomUUID, webcrypto } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CollaborationProjectInventorySchema } from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationCapabilityEvaluator } from "../../packages/gateway/src/collaboration/capability-evaluator.js";
import { CollaborationCapabilityRepository } from "../../packages/gateway/src/collaboration/capability-repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { createDirectSessionRoutes } from "../../packages/gateway/src/collaboration/direct-routes.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { OwnerRuntimeSessionService } from "../../packages/gateway/src/collaboration/owner-runtime-sessions.js";
import { createProjectInventoryService } from "../../packages/gateway/src/collaboration/project-inventory.js";
import { CollaborationProjectScopeService } from "../../packages/gateway/src/collaboration/project-scope.js";
import { createProjectSharingService } from "../../packages/gateway/src/collaboration/project-sharing.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createCollaborationRoutes, type CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/routes.js";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import { ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, proofKeyThumbprint, signEd25519, ticketSigningPayload } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { createCollaborationDirectApi } from "../../packages/ui/src/collaboration/direct-api.js";
import { ProjectSharingButton } from "../../packages/ui/src/collaboration/ProjectSharingButton.js";
import { createRealCollaborationTestDatabase } from "../gateway/collaboration-test-support.js";
import CreateProjectDialog from "@desktop/renderer/src/features/board/CreateProjectDialog";
import type { DesktopProjectSharingContext } from "@desktop/renderer/src/features/project/DesktopProjectSharing";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

const sharingContext = vi.hoisted(() => ({ value: null as DesktopProjectSharingContext | null }));
vi.mock("@desktop/renderer/src/features/project/DesktopProjectSharing", async (importOriginal) => ({
  ...await importOriginal<typeof import("@desktop/renderer/src/features/project/DesktopProjectSharing")>(),
  useDesktopProjectSharingContext: (enabled = true) => enabled ? sharingContext.value : null,
}));

const platform = "https://app.matrix-os.com";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = runtimeId.replace(":", "-");
const ownerId = "user_generation_owner";
const memberId = "user_generation_member";
const organizationId = "org_generation";
const projectId = "proj_generation";
const now = new Date("2026-10-24T12:00:00.000Z");
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 37).toString("base64url"));
const setup = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes`;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

async function fixture() {
  const db = await createRealCollaborationTestDatabase();
  await bootstrapChatDatabase(db.db);
  await bootstrapCollaborationDatabase(db.db);
  const homePath = await mkdtemp(join(tmpdir(), "eng-367-owner-generation-"));
  const projectRoot = join(homePath, "projects", "fresh-project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "README.md"), "A fresh private project\n");
  let runtimeGeneration: number | null = 8;
  let interruptRead = false;
  const project = { id: projectId, ownerId, revision: 1 };
  const repository = new CollaborationRepository(db.db, { now: () => now });
  const precondition = createOrganizationPrecondition({
    source: { async assertMembership({ actorId, organizationId: org }) {
      return (actorId === ownerId || actorId === memberId) && org === organizationId
        ? { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString() } : { member: false };
    } }, now: () => now,
  });
  const capabilities = new CollaborationCapabilityRepository(db.db, { now: () => now, createId: randomUUID });
  const authority = new CollaborationAuthority(repository, { organizationPrecondition: precondition, capabilities, now: () => now });
  const verifier = new DirectTicketVerifier({ runtimeId,
    platformKeys: () => [{ keyId: "platform", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(platformKey) }],
    controlFresh: () => runtimeGeneration !== null, allowedClientOrigins: [platform],
    replay: new DirectReplayCache({ now: () => now }), now: () => now,
  });
  const sessions = new DirectSessionService({ verifier, authority, repository, now: () => now, startTimers: false });
  const ownerSessions = new OwnerRuntimeSessionService({ verifier, ownerId, runtimeId,
    runtimeGeneration: () => runtimeGeneration, organizationPrecondition: precondition, now: () => now });
  const projectScope = new CollaborationProjectScopeService(db.db, {
    runtimeId, preflightSecret: "generation-test-preflight-secret-32-characters", source: { getProject: async () => project }, now: () => now,
  });
  const inventory = createProjectInventoryService({ homePath,
    confirmationSecret: "generation-test-inventory-secret-32-characters", now: () => now,
    source: { getProject: async () => ({ ...project, rootPath: projectRoot }), listChats: async () => [],
      listApps: async () => [], getLayout: async () => null, listTerminals: async () => [] },
  });
  const home = new Hono();
  home.route("/", createDirectSessionRoutes({ sessions, ownerRuntimeSessions: ownerSessions }));
  home.route("/", createCollaborationRoutes({ runtimeId, repository, authority, directSessions: sessions,
    ownerRuntimeSessions: ownerSessions, projectScope, capabilities,
    capabilityEvaluator: new CollaborationCapabilityEvaluator({ db: db.db, grants: capabilities, organizationPrecondition: precondition, now: () => now }),
    verifier: new CollaborationActorProofVerifier({ runtimeId, keys: { legacy: "x".repeat(32) }, authority, now: () => now }),
    projectSharing: createProjectSharingService({ db: db.db, inventory,
      transitions: { replayPreparation: async () => null, prepare: async () => { throw new Error("Confirmation requires an explicit owner action"); } },
      resolveDestination: async () => ({ runtimeId, authorityGeneration: 2 }),
    }),
    executionPolicies: { resolve: async () => null },
    resolveParticipant: async (actorId: string) => ({ actorId, displayName: "Owner" }), now: () => now,
  } as unknown as CollaborationRouteOptions));
  const directory = vi.fn(async () => null);
  const homeLocation = { runtimeId: logicalRuntimeId, origin: "https://owner.test" };
  const relay = new CollaborationRelay({ resolveScopeHome: directory, resolveInvitationHome: async () => null,
    resolveSessionHome: async id => id === logicalRuntimeId ? homeLocation : null,
    resolveRuntimeHome: async (actor, id) => actor === ownerId && id === runtimeId ? homeLocation : null,
    resolveOwnerRuntimeHome: async (actor, id) => actor === ownerId && id === logicalRuntimeId ? homeLocation : null,
    fetchImpl: (async (input, init) => home.request(new URL(String(input)).pathname, init)) as typeof fetch,
  });
  const calls: Array<{ method: string; path: string; status: number }> = [];
  const api = createCollaborationDirectApi({ platformBaseUrl: platform, clientOrigin: platform, now: () => now,
    subtle: webcrypto.subtle as SubtleCrypto,
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      let response: Response;
      if (url.pathname === "/api/organizations") {
        response = Response.json({ complete: true, organizations: [{ organizationId, name: "Matrix Main", slug: "matrix-main",
          role: "org:member", memberCount: 2, aiSubmission: "members", membershipEpoch: 1 }] });
      } else if (url.pathname === `/api/organizations/${organizationId}/members`) {
        response = Response.json({ members: [ownerId, memberId].map(actorId => ({ actorId,
          displayName: actorId === ownerId ? "Owner" : "Member", role: "org:member", joinedAt: now.toISOString() })) });
      } else if (url.pathname === "/api/collaboration/owner-runtime/connections") {
        if (runtimeGeneration === null) return Response.json({ error: "Collaboration unavailable" }, { status: 503 });
        const request = JSON.parse(String(init?.body));
        const ticket = { protocolVersion: 2, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
          actorId: ownerId, organizationId, resource: { kind: "owner_runtime" }, purpose: "owner_runtime",
          runtime: { runtimeId: logicalRuntimeId, authorityGeneration: runtimeGeneration }, proofKeyThumbprint: proofKeyThumbprint(request.proofPublicKey),
          maxActions: 32, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString() };
        response = Response.json({ signedTicket: { ticket, keyId: "platform", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) },
          endpoint: { origin: platform, protocolVersion: 2 } }, { status: 201 });
      } else {
        if (interruptRead && method === "GET" && /\/scopes\/[0-9a-f-]{36}$/.test(url.pathname)) runtimeGeneration = null;
        response = await relay.forward({ actorId: ownerId, method, path: url.pathname, query: url.search.slice(1),
          headers: new Headers(init?.headers), body: typeof init?.body === "string" ? new TextEncoder().encode(init.body) : null });
      }
      calls.push({ method, path: url.pathname, status: response.status });
      return response;
    }) as typeof fetch,
  });
  return { api, calls, directory, db: db.db,
    touchFile: () => utimes(join(projectRoot, "README.md"), new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z")),
    interrupt() { interruptRead = true; },
    recover() { interruptRead = false; runtimeGeneration = 9; },
    async close() { cleanup(); api.direct.close(); relay.close(); await sessions.shutdown(); await ownerSessions.shutdown(); await db.destroy(); await rm(homePath, { recursive: true, force: true }); },
  };
}

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("owner Share with independent registration and project generations", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });
  const openShare = () => {
    render(<ProjectSharingButton api={f.api} runtimeId={runtimeId} organizationId={organizationId} organizationName="Matrix Main"
      projectId={projectId} projectName="Fresh project" />);
    fireEvent.click(screen.getByRole("button", { name: "Share project" }));
  };
  const expectDialog = async () => {
    await waitFor(() => expect(f.calls.filter(call => call.path.endsWith("/project/inventory")).at(-1))
      .toMatchObject({ status: 200 }), { timeout: 10_000 });
    await screen.findByRole("heading", { name: "Share “Fresh project”" });
    return screen.findByRole("button", { name: /^General access:/ });
  };
  const assertPrivate = async () => {
    expect((await f.db.selectFrom("collaboration_scopes").select(["lifecycle", "authority_generation"]).execute())
      .map(scope => ({ ...scope, authority_generation: Number(scope.authority_generation) }))).toEqual([
      { lifecycle: "private", authority_generation: 1 },
    ]);
    expect(await f.db.selectFrom("collaboration_directory_outbox").select("event_id").execute()).toEqual([]);
    expect(f.calls.some(call => call.path.endsWith("/project/confirm"))).toBe(false);
  };

  it("opens the first-click dialog through real scope creation/read, default grant and filesystem inventory at runtime generation 8", async () => {
    f = await fixture();
    openShare();
    await expectDialog();
    expect(f.calls.slice(0, 8).map(call => [call.method, call.path.replace(/\/scopes\/[0-9a-f-]{36}/, "/scopes/:id"), call.status])).toEqual([
      ["POST", "/api/collaboration/owner-runtime/connections", 201], ["POST", "/api/collaboration/owner-runtime/sessions", 201],
      ["POST", `${setup}/preflight`, 200], ["POST", setup, 201], ["GET", "/api/collaboration/scopes/:id", 200],
      ["GET", "/api/collaboration/scopes/:id/grants", 200], ["POST", "/api/collaboration/scopes/:id/grants", 201],
      ["GET", "/api/collaboration/scopes/:id/project/inventory", 200],
    ]);
    expect(f.directory).toHaveBeenCalled();
    const scope = await f.db.selectFrom("collaboration_scopes").select("id").executeTakeFirstOrThrow();
    const inventory = await f.api.get(`/api/collaboration/scopes/${scope.id}/project/inventory`) as { ownedItems: unknown[] };
    expect(inventory.ownedItems).toEqual([expect.objectContaining({ kind: "file", id: "README.md", revision: "0",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), byteCount: 24 })]);
    await assertPrivate();
  });

  it("resumes an untouched private scope left by a failed setup and creates its unpublished default grant", async () => {
    f = await fixture();
    const preflight = await f.api.post(`${setup}/preflight`, { kind: "project", resourceId: projectId, organizationId }) as { resourceRevision: string; confirmationToken: string };
    await f.api.post(setup, { kind: "project", resourceId: projectId, organizationId, clientRequestId: randomUUID(),
      expectedRevision: preflight.resourceRevision, confirmationToken: preflight.confirmationToken });
    openShare();
    await expectDialog();
    expect(await f.db.selectFrom("collaboration_grants").select(["audience_kind", "state"]).execute()).toEqual([
      { audience_kind: "organization", state: "active" },
    ]);
    await assertPrivate();
  });

  it("keeps the full file metadata bound to confirmation despite decimal wire revision sentinels", async () => {
    f = await fixture();
    openShare();
    await expectDialog();
    const scope = await f.db.selectFrom("collaboration_scopes").select("id").executeTakeFirstOrThrow();
    const base = `/api/collaboration/scopes/${scope.id}`;
    const before = CollaborationProjectInventorySchema.parse(await f.api.get(`${base}/project/inventory`));
    await f.touchFile();
    const after = CollaborationProjectInventorySchema.parse(await f.api.get(`${base}/project/inventory`));
    expect(after.ownedItems).toEqual(before.ownedItems);
    expect(after.inventoryHash).not.toBe(before.inventoryHash);
    await expect(f.api.post(`${base}/project/confirm`, { clientRequestId: randomUUID(),
      expectedScopeRevision: before.scopeRevision, expectedProjectRevision: before.projectRevision,
      inventoryHash: before.inventoryHash, membershipHash: before.membershipHash, inventoryToken: before.inventoryToken,
    })).rejects.toThrow("CollaborationUnavailable");
    expect(f.calls.filter(call => call.path === `${base}/project/confirm`).at(-1)).toMatchObject({ method: "POST", status: 409 });
    expect((await f.db.selectFrom("collaboration_scopes").select("lifecycle").executeTakeFirstOrThrow()).lifecycle).toBe("private");
    expect(await f.db.selectFrom("collaboration_directory_outbox").select("event_id").execute()).toEqual([]);
  });

  it("preserves a previously chosen Viewer audience when resuming a private scope", async () => {
    f = await fixture();
    const preflight = await f.api.post(`${setup}/preflight`, { kind: "project", resourceId: projectId, organizationId }) as { resourceRevision: string; confirmationToken: string };
    const scope = await f.api.post(setup, { kind: "project", resourceId: projectId, organizationId, clientRequestId: randomUUID(),
      expectedRevision: preflight.resourceRevision, confirmationToken: preflight.confirmationToken }) as { id: string; revision: string };
    await f.api.post(`/api/collaboration/scopes/${scope.id}/grants`, { clientRequestId: randomUUID(),
      expectedRevision: scope.revision, audience: { kind: "organization" }, preset: "viewer" });
    const before = f.calls.length;
    openShare();
    await expectDialog();
    expect(await f.db.selectFrom("collaboration_grants").select(["preset", "state"]).execute()).toEqual([
      { preset: "viewer", state: "active" },
    ]);
    expect(f.calls.slice(before).some(call => call.method === "POST" && call.path.endsWith("/grants"))).toBe(false);
    await assertPrivate();
  });

  it("keeps a private scope Restricted after the owner revoked its earlier organization grant", async () => {
    f = await fixture();
    const preflight = await f.api.post(`${setup}/preflight`, { kind: "project", resourceId: projectId, organizationId }) as { resourceRevision: string; confirmationToken: string };
    const scope = await f.api.post(setup, { kind: "project", resourceId: projectId, organizationId, clientRequestId: randomUUID(),
      expectedRevision: preflight.resourceRevision, confirmationToken: preflight.confirmationToken }) as { id: string; revision: string };
    const base = `/api/collaboration/scopes/${scope.id}`;
    const grant = await f.api.post(`${base}/grants`, { clientRequestId: randomUUID(), expectedRevision: scope.revision,
      audience: { kind: "organization" }, preset: "viewer" }) as { id: string; revision: string };
    const current = await f.api.get(base) as { revision: string };
    await f.api.delete(`${base}/grants/${grant.id}`, { clientRequestId: randomUUID(),
      expectedRevision: current.revision, expectedMemberRevision: grant.revision });
    const before = f.calls.length;
    openShare();
    await expectDialog();
    expect(await f.db.selectFrom("collaboration_grants").select(["preset", "state"]).execute()).toEqual([
      { preset: "viewer", state: "revoked" },
    ]);
    expect(f.calls.slice(before).some(call => call.method === "POST" && call.path.endsWith("/grants"))).toBe(false);
    expect(screen.getByRole("button", { name: "General access: Restricted" })).toBeTruthy();
    await assertPrivate();
  });

  it("hands share-after-create to the real owner setup flow after the creation dialog closes", async () => {
    f = await fixture();
    sharingContext.value = { api: f.api, runtimeId, organizationId, organizationStatus: "member" };
    useConnection.setState({ organizationId, organizationStatus: "member", status: "signed-in", runtimeSlot: "primary", api: {} as never });
    useBoard.setState({ projects: [], activeProjectSlug: null, cardsByProject: {}, firstLoadByProject: {},
      createProject: vi.fn(async () => ({ id: projectId, slug: "fresh-project", name: "Fresh project", kind: "scratch" as const })),
      selectProject: vi.fn(async () => undefined) });
    useTabs.setState({ tabs: [], activeTabId: null, openTab: vi.fn() });
    function CreationJourney() {
      const [open, setOpen] = React.useState(true);
      return <Tooltip.Provider><CreateProjectDialog open={open} onClose={() => setOpen(false)} /></Tooltip.Provider>;
    }
    render(<CreationJourney />);
    fireEvent.change(screen.getByLabelText("What are you working on?"), { target: { value: "Fresh project" } });
    fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Share project after creating" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await expectDialog();
    expect(screen.queryByRole("dialog", { name: "Create a project" })).toBeNull();
    expect(useBoard.getState().createProject).toHaveBeenCalledOnce();
    await assertPrivate();
  });

  it("keeps a failed setup private and unpublished, then recovers the same scope after current control returns", async () => {
    f = await fixture();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.interrupt();
    openShare();
    await screen.findByText("Project sharing is unavailable. The project remains private and unchanged.");
    await assertPrivate();
    expect(await f.db.selectFrom("collaboration_grants").select("id").execute()).toEqual([]);
    f.recover();
    fireEvent.click(screen.getByRole("button", { name: "Share project" }));
    await expectDialog();
    expect(f.calls.filter(call => call.method === "POST" && call.path === setup)).toHaveLength(1);
    await assertPrivate();
  });
});
