import {PreviewPairHandleSchema} from "@matrix-os/contracts/preview-pair";
import { isPrivatePreviewHandle } from "@matrix-os/contracts";

/** A configured per-owner update base intentionally has no public channels. */
export function isOwnerManagedPreviewUpdateBase(base: string | undefined): boolean {
  if (!base) return false;
  try {
    const path=new URL(base).pathname;
    const match = path.match(/^\/private-preview-updates\/([^/]+)\/?$/);
    const pair=path.match(/^\/preview-pair-updates\/([^/]+)\/?$/);
    return Boolean((match && isPrivatePreviewHandle(match[1]!))||(pair && PreviewPairHandleSchema.safeParse(pair[1]).success));
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}
