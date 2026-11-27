/**
 * ENG-579: an organization app share binds to its exact build's completed readiness.
 * `ready` grants members full app use; `blocked` (the app is not collaborative) grants
 * members read-only use of the owner's data. Unfinished, failed, or stale readiness is never
 * shareable. Access is always re-derived from the bound readiness row, never chosen by a client.
 */
export const SHAREABLE_APP_READINESS_STATUSES = ["ready", "blocked"] as const;

export type CollaborativeAppShareAccess = "full" | "read_only";

export function isShareableAppReadiness(status: string, invalidatedAt: unknown): boolean {
  return (status === "ready" || status === "blocked") && (invalidatedAt === null || invalidatedAt === undefined);
}

export function appShareAccess(status: string): CollaborativeAppShareAccess | null {
  if (status === "ready") return "full";
  if (status === "blocked") return "read_only";
  return null;
}

/** Response header the owner sets on a read-only share's entry document for the platform launcher. */
export const COLLABORATIVE_APP_ACCESS_HEADER = "x-matrix-app-access";
