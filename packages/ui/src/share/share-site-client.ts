import type { SitePublishing, SiteRecord, SiteSlugAvailability } from "@matrix-os/contracts";

/**
 * The part of the shell `SiteClient` (shell/src/lib/site-client.ts) the Share
 * popover uses. Declared structurally so packages/ui does not import the shell;
 * both the Web and Electron site clients satisfy it.
 */
export interface ShareSiteClient {
  get(app: string, signal: AbortSignal): Promise<SiteRecord | null>;
  deploy(app: string, metadata: { title: string; description: string; slug: string | null; accessMode?: "public" | "private_link"; baseRevision?: number; reviewedConfig: SitePublishing }, signal: AbortSignal): Promise<SiteRecord>;
  update(app: string, metadata: { title: string; description: string; slug: string | null; accessMode?: "public" | "private_link"; baseRevision?: number }, signal: AbortSignal): Promise<SiteRecord>;
  unpublish(app: string, revision: number, signal: AbortSignal): Promise<SiteRecord>;
  getConfig(app: string, signal: AbortSignal): Promise<SitePublishing>;
  slugAvailability(app: string, slug: string, signal: AbortSignal): Promise<SiteSlugAvailability>;
}

/** HTTP status carried by shell `SiteClientError` / adapter errors, if any. */
export function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  const status = (error as { status: unknown }).status;
  return typeof status === "number" ? status : null;
}

const SAFE_ERRORS: Record<number, string> = {
  409: "This changed somewhere else. Refresh and try again.",
  413: "This app is too large to publish.",
  429: "Too many requests. Try again in a moment.",
  503: "Sharing is unavailable right now. Try again.",
};

/** Allowlisted copy only; never surface server, provider or path details. */
export function shareErrorMessage(error: unknown, fallback = "Something went wrong. Try again."): string {
  const status = errorStatus(error);
  return (status !== null ? SAFE_ERRORS[status] : undefined) ?? fallback;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
