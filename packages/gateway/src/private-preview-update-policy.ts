import { isPrivatePreviewHandle } from "@matrix-os/contracts";

/** A configured per-owner update base intentionally has no public channels. */
export function isOwnerManagedPreviewUpdateBase(base: string | undefined): boolean {
  if (!base) return false;
  try {
    const match = new URL(base).pathname.match(/^\/private-preview-updates\/([^/]+)\/?$/);
    return Boolean(match && isPrivatePreviewHandle(match[1]!));
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}
