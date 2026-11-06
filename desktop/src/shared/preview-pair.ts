import { z } from "zod/v4";
import { PreviewPairLaunchContextSchema } from "@matrix-os/contracts/preview-pair-launch";
const shape = PreviewPairLaunchContextSchema.shape;
/** Public presentation facts only. No proof, nonce, path, credential or new org state. */
export const DesktopPreviewSummarySchema = z.strictObject({ role: shape.role, pr: shape.pr, sourceSha: shape.sourceSha,
  handle: shape.handle, organizationId: shape.organizationId });
export type DesktopPreviewSummary = z.infer<typeof DesktopPreviewSummarySchema>;
