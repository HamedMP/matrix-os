import { describe, expect, it, vi } from "vitest";
import { loadOrganizationDriveOptions } from "@matrix-os/ui";

const SCOPE = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION = "org_example";

describe("organization drive discovery", () => {
  it("loads an accepted folder share and its drive snapshot", async () => {
    const get = vi.fn(async (path: string): Promise<unknown> => {
      if (path.startsWith("/api/collaboration/inbox")) return { items: [] };
      if (path.startsWith("/api/collaboration/shared")) return { items: [{
        scopeId: SCOPE, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "folder",
        authorityGeneration: 1, organizationId: ORGANIZATION, status: "accepted",
      }] };
      if (path === "/api/organizations") return { organizations: [{ organizationId: ORGANIZATION, name: "Authority" }] };
      throw new Error("Unexpected path");
    });
    const request = vi.fn(async (_scopeId: string, _method: string, path: string): Promise<unknown> => {
      if (path.endsWith(`/scopes/${SCOPE}`)) return { id: SCOPE, ownerId: "user_owner", kind: "folder",
        resourceId: "folder_example", organizationId: ORGANIZATION, membershipMode: "direct", lifecycle: "shared",
        revision: "1", authEpoch: "1", authorityGeneration: "1", role: "viewer",
        capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false } };
      if (path.endsWith("/drive")) return { organizationId: ORGANIZATION, scopeId: SCOPE,
        usedBytes: 0, reservedBytes: 0, quotaBytes: 1_000_000_000_000, files: [] };
      throw new Error("Unexpected path");
    });
    const options = await loadOrganizationDriveOptions({ get, direct: { request } } as never, {});
    expect(options).toEqual([{ scopeId: SCOPE, organizationId: ORGANIZATION, name: "Authority",
      state: "ready", canManage: false, canUpload: false, snapshot: expect.objectContaining({ files: [] }), pages: 1 }]);
  });
});
