import { randomUUID } from "node:crypto";
import {
  CollaborationDiscoveryResponseSchema,
  CollaborationGrantSchema,
  CollaborationProjectInventorySchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { collaborationTest as test, expect } from "../fixtures/collaboration.js";
import { assertMachineFreeJourney, assertNonDisclosingDenial } from "./journey-assertions.js";

const ProjectResponse = z.object({ project: z.object({ id: z.string().min(1), slug: z.string().min(1) }).passthrough() }).passthrough();
const RuntimeInfo = z.object({ runtime: z.object({ machineId: z.uuid() }).passthrough(), capabilities: z.object({ collaboration: z.literal(true) }).passthrough() }).passthrough();
const SCOPE_ROUTES = [
  "", "/access", "/grants", "/members", "/project", "/project/inventory", "/policy",
] as const;

test("a preview project share uses the home, preserves machine-free identities, and denies nonmembers", async ({ collaborationJourney }) => {
  const { actors, config } = collaborationJourney;
  const { owner, member, outsider, guest } = actors;
  for (const actor of [member, outsider, guest]) assertMachineFreeJourney(actor.preconditions);

  const slug = `m-e2e-${randomUUID().slice(0, 12)}`;
  const name = `Matrix E2E ${slug}`;
  const previewRoot = `/vm/${encodeURIComponent(config.previewHandle)}`;
  let createdProject = false;
  let scopeId: string | null = null;
  let grantId: string | null = null;
  try {
    const runtimeResponse = await owner.context.request.get(`${config.baseUrl}${previewRoot}/api/system/info`, { timeout: 10_000 });
    expect(runtimeResponse.ok()).toBe(true);
    const runtime = RuntimeInfo.parse(await runtimeResponse.json());
    const runtimeId = `vps:${runtime.runtime.machineId}`;

    const createResponse = await owner.context.request.post(`${config.baseUrl}${previewRoot}/api/projects`, {
      data: { mode: "scratch", slug, name, clientRequestId: `req_${randomUUID().replaceAll("-", "")}` },
      timeout: 10_000,
    });
    expect(createResponse.ok()).toBe(true);
    createdProject = true;
    const project = ProjectResponse.parse(await createResponse.json()).project;
    expect(project.slug).toBe(slug);

    const setupPath = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes`;
    const preflight = CollaborationScopePreflightResponseSchema.parse(await owner.direct.post(`${setupPath}/preflight`, {
      kind: "project", resourceId: project.id, organizationId: config.organizationId,
    }));
    expect(preflight.eligible).toBe(true);
    expect(preflight.confirmationToken).toBeDefined();
    const privateScope = CollaborationScopeSchema.parse(await owner.direct.post(setupPath, {
      kind: "project", resourceId: project.id, organizationId: config.organizationId,
      clientRequestId: randomUUID(), expectedRevision: preflight.resourceRevision,
      confirmationToken: preflight.confirmationToken,
    }));
    scopeId = privateScope.id;
    expect(privateScope.lifecycle).toMatch(/private|preparing/);
    const base = `/api/collaboration/scopes/${scopeId}`;
    const inventory = CollaborationProjectInventorySchema.parse(await owner.direct.get(`${base}/project/inventory`));
    expect(inventory.projectId).toBe(project.id);
    expect(inventory.scopeId).toBe(scopeId);
    expect(inventory.blockers).toHaveLength(0);
    await owner.direct.post(`${base}/project/confirm`, {
      clientRequestId: randomUUID(), expectedScopeRevision: inventory.scopeRevision,
      expectedProjectRevision: inventory.projectRevision, inventoryHash: inventory.inventoryHash,
      membershipHash: inventory.membershipHash, inventoryToken: inventory.inventoryToken,
    });
    await expect.poll(async () => CollaborationScopeSchema.parse(await owner.direct.get(base)).lifecycle, { timeout: 25_000 }).toBe("shared");
    const sharedScope = CollaborationScopeSchema.parse(await owner.direct.get(base));
    const grant = CollaborationGrantSchema.parse(await owner.direct.post(`${base}/grants`, {
      clientRequestId: randomUUID(), expectedRevision: sharedScope.revision,
      audience: { kind: "organization" }, preset: "contributor",
    }));
    grantId = grant.id;

    // The platform projection carries only a pointer. The member asks the home to activate it.
    const loadPointer = async () => {
      const response = await member.context.request.get(`${config.baseUrl}/api/collaboration/inbox`, { timeout: 10_000 });
      expect(response.ok()).toBe(true);
      const page = CollaborationDiscoveryResponseSchema.parse(await response.json());
      return page.items.find((item) => item.scopeId === scopeId);
    };
    await expect.poll(async () => loadPointer(), { timeout: 25_000 })
      .toMatchObject({ status: "organization_pending", grantId });
    const pointer = await loadPointer();
    expect(pointer && "resource" in pointer).toBe(false);
    await member.direct.post(`${base}/grants/${grantId}/accept`, {});
    const memberScope = CollaborationScopeSchema.parse(await member.direct.get(base));
    expect(memberScope.role).toBe("editor");
    expect(memberScope.capabilities).toBeDefined();

    // The direct client obtains a ticket and a home session for each request. A
    // nonmember cannot use either to read any route in this scope.
    for (const actor of [outsider, guest]) {
      for (const suffix of SCOPE_ROUTES) {
        let denial: unknown;
        try { await actor.direct.direct.request(scopeId, "GET", `${base}${suffix}`); }
        catch (error: unknown) { denial = error; }
        assertNonDisclosingDenial(denial, [scopeId, project.id, runtimeId, actor.userId]);
      }
      const discovery = CollaborationDiscoveryResponseSchema.parse(await actor.direct.get("/api/collaboration/shared"));
      expect(discovery.items.some((item) => item.scopeId === scopeId)).toBe(false);
    }
    expect(CollaborationScopeSchema.parse(await owner.direct.get(base)).id).toBe(scopeId);

    const afterGrant = CollaborationScopeSchema.parse(await owner.direct.get(base));
    const downgraded = CollaborationGrantSchema.parse(await owner.direct.patch!(`${base}/grants/${grantId}`, {
      clientRequestId: randomUUID(), expectedRevision: afterGrant.revision,
      expectedGrantRevision: grant.revision, preset: "viewer",
    }));
    expect(downgraded.preset).toBe("viewer");
    await expect.poll(async () => CollaborationScopeSchema.parse(await member.direct.get(base)).role, { timeout: 25_000 }).toBe("viewer");

    const beforeRevoke = CollaborationScopeSchema.parse(await owner.direct.get(base));
    await owner.direct.delete(`${base}/grants/${grantId}`, {
      clientRequestId: randomUUID(), expectedRevision: beforeRevoke.revision,
      expectedMemberRevision: downgraded.revision,
    });
    grantId = null;
    await expect.poll(async () => {
      try { await member.direct.direct.request(scopeId!, "GET", base); return "allowed"; }
      catch (error: unknown) { return error instanceof Error && "code" in error ? String(error.code) : "unexpected"; }
    }, { timeout: 25_000 }).toMatch(/^(denied|host_offline)$/);
    expect(CollaborationScopeSchema.parse(await owner.direct.get(base)).id).toBe(scopeId);
    for (const actor of [member, outsider, guest]) {
      const [computerResponse, journeyResponse] = await Promise.all([
        actor.context.request.get(`${config.baseUrl}/api/auth/computers`, { timeout: 10_000 }),
        actor.context.request.get(`${config.baseUrl}/api/journey`, { timeout: 10_000 }),
      ]);
      expect(computerResponse.ok()).toBe(true);
      expect(journeyResponse.ok()).toBe(true);
      const computers = z.object({ items: z.array(z.object({ handle: z.string() }).passthrough()), hasMore: z.literal(false) }).passthrough().parse(await computerResponse.json());
      const journey = z.object({ phase: z.string() }).passthrough().parse(await journeyResponse.json());
      assertMachineFreeJourney({ computers: computers.items, phase: journey.phase });
    }
  } finally {
    // This is a dedicated preview owner and a run-specific project. Cleanup is
    // best effort here; the A4 evidence must list any retained slug for review.
    if (scopeId) {
      try {
        const current = CollaborationScopeSchema.parse(await owner.direct.get(`/api/collaboration/scopes/${scopeId}`));
        if (grantId) {
          const grants = z.array(CollaborationGrantSchema).parse(await owner.direct.get(`/api/collaboration/scopes/${scopeId}/grants`));
          const grant = grants.find((item) => item.id === grantId);
          if (grant && grant.state !== "revoked") await owner.direct.delete(`/api/collaboration/scopes/${scopeId}/grants/${grantId}`, {
            clientRequestId: randomUUID(), expectedRevision: current.revision, expectedMemberRevision: grant.revision,
          });
        }
        const latest = CollaborationScopeSchema.parse(await owner.direct.get(`/api/collaboration/scopes/${scopeId}`));
        await owner.direct.post(`/api/collaboration/scopes/${scopeId}/lifecycle`, {
          type: "delete", clientRequestId: randomUUID(), expectedRevision: latest.revision,
        });
      } catch (error: unknown) { console.warn("[collaboration-e2e] preview scope cleanup failed", { scopeId, slug, error: error instanceof Error ? error.name : "UnknownError" }); }
    }
    if (createdProject) {
      try {
        const response = await owner.context.request.delete(`${config.baseUrl}${previewRoot}/api/projects/${slug}`, {
          data: { confirmation: name, confirmTerminate: true }, timeout: 10_000,
        });
        if (!response.ok()) console.warn("[collaboration-e2e] preview project cleanup failed", { scopeId, slug, status: response.status() });
      } catch (error: unknown) { console.warn("[collaboration-e2e] preview project cleanup failed", { scopeId, slug, error: error instanceof Error ? error.name : "UnknownError" }); }
    }
  }
});
