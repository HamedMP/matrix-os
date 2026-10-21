import { z } from "zod/v4";

export const DriveFileId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const DriveReadParams = z.strictObject({
  fileId: DriveFileId,
  mimeType: z.string().min(1).max(128).optional(),
  exportMimeType: z.enum(["text/plain", "text/markdown", "text/csv", "text/tab-separated-values"]).optional(),
});
export const DriveReadInput = DriveReadParams.extend({
  externalUserId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
  accountId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
});
