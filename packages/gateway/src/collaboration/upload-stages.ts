/**
 * S12 / T062: staged uploads. Layer 1 freezes the seam the file action route
 * calls; the stager itself (multipart parts, checksum verification, TTL sweep,
 * revocation cancel) lands in the transfer layer.
 */
import type { CollaborationFileActionRequest, CollaborationUpload } from "@matrix-os/contracts";
import type { AuthorizedCollaborationContext } from "./authority.js";
import type { CatalogEntryRecord } from "./resource-catalog.js";

export type CollaborationUploadAction = Extract<
  CollaborationFileActionRequest,
  { type: "upload_stage" | "upload_part" | "upload_commit" | "upload_cancel" }
>;

export interface CollaborationUploadResult {
  entry?: CatalogEntryRecord;
  upload?: CollaborationUpload;
  replayed: boolean;
}

export interface CollaborationUploadStager {
  handle(context: AuthorizedCollaborationContext, action: CollaborationUploadAction): Promise<CollaborationUploadResult>;
}
