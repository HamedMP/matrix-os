import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerOrganizationDriveRoutes } from "../../packages/gateway/src/organization-drive/routes.js";
import type { CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/route-support.js";

const scopeId = "00000000-0000-4000-8000-000000000001";
const path = `/api/collaboration/scopes/${scopeId}/drive`;
const proof = { "x-matrix-collaboration-proof": "e30" };

function fixture(kind: "folder" | "file" = "folder") {
  const usage = vi.fn().mockResolvedValue({ usedBytes: 0, reservedBytes: 0, quotaBytes: 1_000_000_000_000 });
  const list = vi.fn().mockResolvedValue([]);
  const enable = vi.fn().mockResolvedValue(undefined);
  const verifyAndAuthorize = vi.fn().mockResolvedValue({ actorId: "user_ash", ownerId: "user_ash",
    organizationId: "org_authority", scopeId, membershipScopeId: scopeId, resourceKind: kind,
    resourceId: "00000000-0000-4000-8000-000000000002", role: "owner", authEpoch: 1,
    authorityRuntimeId: "vps:ash", authorityGeneration: 1, capability: "read" });
  const app = new Hono();
  registerOrganizationDriveRoutes(app, { verifier: { verifyAndAuthorize },
    authority: {}, organizationDrive: { usage, list, enable } } as unknown as CollaborationRouteOptions);
  return { app, usage, list, enable, verifyAndAuthorize };
}

describe("organization drive HTTP boundary", () => {
  it("lists only after scope authorization and binds to the exact organization", async () => {
    const f = fixture();
    const result = await f.app.request(path, { headers: proof });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ organizationId: "org_authority", files: [] });
    expect(f.usage).toHaveBeenCalledWith({ organizationId: "org_authority", scopeId,
      authorityRuntimeId: "vps:ash", authorityGeneration: 1 });
  });

  it("rejects a non-folder scope before touching the drive", async () => {
    const f = fixture("file");
    const result = await f.app.request(path, { headers: proof });
    expect(result.status).toBe(404);
    expect(f.usage).not.toHaveBeenCalled();
  });

  it("requires owner authority to enable a drive", async () => {
    const f = fixture();
    const result = await f.app.request(path, { method: "PUT", headers: { ...proof, "Content-Type": "application/json" }, body: "{}" });
    expect(result.status).toBe(200);
    expect(f.enable).toHaveBeenCalledWith({ organizationId: "org_authority", scopeId,
      authorityRuntimeId: "vps:ash", authorityGeneration: 1, runtimeId: "vps:ash", generation: 1 });
  });
});
