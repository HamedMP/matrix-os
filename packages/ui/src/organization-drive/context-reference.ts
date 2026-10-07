import { CanonicalChatResourceReferenceSchema, type CanonicalChatResourceReference, type OrganizationDriveContextReference } from "@matrix-os/contracts";
import type { OrganizationDriveOption } from "./discovery.js";
/** Truncate only a display label; authority references retain their complete logical path. */
export function companyDriveChatReference(drive: Pick<OrganizationDriveOption, "name" | "scopeId" | "organizationId">, selection?: {
    kind: "folder";
    path: string;
} | {
    kind: "file";
    fileId: string;
    version: number;
    path: string;
}): CanonicalChatResourceReference {
    const identity = { organizationId: drive.organizationId, scopeId: drive.scopeId };
    const reference: OrganizationDriveContextReference = selection?.kind === "folder" ? { ...identity, kind: "folder", path: selection.path } : selection?.kind === "file" ? { ...identity, kind: "file", fileId: selection.fileId, version: selection.version } : { ...identity, kind: "drive" };
    const label = `${drive.name}${selection ? ` / ${selection.path}` : ""}`.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 278).replace(/[\uD800-\uDBFF]$/, "");
    return CanonicalChatResourceReferenceSchema.parse({ kind: "organization_drive", id: drive.scopeId, label, drive: reference });
}
