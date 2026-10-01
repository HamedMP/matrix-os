import {
  CollaborationGrantSchema,
  CollaborationScopeSchema,
  OrganizationDriveSnapshotSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { CollaborationDirectApi } from "../collaboration/direct-api.js";
import { loadDiscoveryItems, loadDriveSnapshotPages } from "./paging.js";

const OrganizationsSchema = z.object({ organizations: z.array(z.object({
  organizationId: z.string(), name: z.string(),
}).passthrough()).max(100) }).passthrough();
const GrantsSchema = z.array(CollaborationGrantSchema).max(100);

export type OrganizationDriveOption = {
  scopeId: string;
  organizationId: string;
  name: string;
  state: "ready" | "enable" | "pending";
  canManage?: boolean;
  canUpload?: boolean;
  grantId?: string;
  snapshot?: z.infer<typeof OrganizationDriveSnapshotSchema>;
  pages?: number;
};
export type OrganizationDrivePageCounts = Record<string, number>;

async function inspectScope(api: CollaborationDirectApi, scopeId: string, organizationId: string, name: string,
  pages: number): Promise<OrganizationDriveOption | null> {
  const scope = CollaborationScopeSchema.parse(await api.direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`));
  if (scope.kind !== "folder" || scope.organizationId !== organizationId) return null;
  try {
    const loaded = await loadDriveSnapshotPages((path) => api.direct.request(scopeId, "GET", path), scopeId, pages);
    return { scopeId, organizationId, name, state: "ready", canManage: scope.role === "owner",
      canUpload: scope.role !== "viewer", ...loaded };
  } catch (error: unknown) {
    if (scope.role === "owner") return { scopeId, organizationId, name, state: "enable", canManage: true, canUpload: true };
    console.warn("[organization-drive] scope inspection unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function loadOrganizationDriveOptions(api: CollaborationDirectApi,
  pageCounts: OrganizationDrivePageCounts): Promise<OrganizationDriveOption[]> {
  const get = (path: string) => api.get(path);
  const [inbox, shared, organizations] = await Promise.all([
    loadDiscoveryItems(get, "inbox"), loadDiscoveryItems(get, "shared"), api.get("/api/organizations"),
  ]);
  const names = new Map(OrganizationsSchema.parse(organizations).organizations.map((org) => [org.organizationId, org.name]));
  const items = [...inbox, ...shared];
  const seen = new Set<string>();
  const options: OrganizationDriveOption[] = [];
  const accepted: Array<{ scopeId: string; organizationId: string; name: string }> = [];
  for (const item of items) {
    if (item.kind !== "folder" || seen.has(item.scopeId) || !item.organizationId) continue;
    seen.add(item.scopeId);
    const name = names.get(item.organizationId) ?? "Organization";
    if (item.status === "organization_pending") {
      options.push({ scopeId: item.scopeId, organizationId: item.organizationId, name,
        state: "pending", grantId: item.grantId });
      continue;
    }
    if (item.status !== "accepted") continue;
    accepted.push({ scopeId: item.scopeId, organizationId: item.organizationId, name });
  }
  for (let offset = 0; offset < accepted.length; offset += 4) {
    const batch = await Promise.all(accepted.slice(offset, offset + 4).map(async (item) => {
      try { return await inspectScope(api, item.scopeId, item.organizationId, item.name, pageCounts[item.scopeId] ?? 1); }
      catch (error: unknown) {
        console.warn("[organization-drive] share unavailable", error instanceof Error ? error.name : "UnknownError");
        return null;
      }
    }));
    for (const option of batch) if (option) options.push(option);
  }
  return options;
}

export async function ensureOrganizationContributorGrant(api: CollaborationDirectApi, scopeId: string): Promise<void> {
  const scope = CollaborationScopeSchema.parse(await api.direct.request(scopeId, "GET",
    `/api/collaboration/scopes/${scopeId}`));
  const grants = GrantsSchema.parse(await api.direct.request(scopeId, "GET",
    `/api/collaboration/scopes/${scopeId}/grants`));
  const activeGrant = grants.find((grant) => grant.audience.kind === "organization"
    && grant.state !== "revoked" && grant.state !== "expired");
  if (activeGrant?.preset === "viewer") {
    await api.direct.request(scopeId, "PATCH", `/api/collaboration/scopes/${scopeId}/grants/${activeGrant.id}`, {
      clientRequestId: crypto.randomUUID(), expectedRevision: scope.revision,
      expectedGrantRevision: activeGrant.revision, preset: "contributor",
    });
  } else if (!activeGrant) {
    await api.direct.request(scopeId, "POST", `/api/collaboration/scopes/${scopeId}/grants`, {
      clientRequestId: crypto.randomUUID(), expectedRevision: scope.revision,
      audience: { kind: "organization" }, preset: "contributor",
    });
  }
}
