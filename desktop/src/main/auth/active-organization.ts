// Active organization for Electron Desktop Share controls (spec 535 FR-024).
// Web reads the active Clerk organization from the browser session; the
// trusted core has no Clerk session, so it resolves the organization from the
// platform membership listing with the device credential and hands the
// renderer only the validated identifier through `auth:status`.
import { CollaborationOrganizationIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { readBoundedResponseText } from "./bounded-response";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Minimum age before a window-focus refresh asks the platform again. */
export const ACTIVE_ORGANIZATION_REFRESH_INTERVAL_MS = 60_000;

const ORGANIZATIONS_TIMEOUT_MS = 10_000;
const ORGANIZATIONS_RESPONSE_LIMIT = 64 * 1024;
// Mirrors the platform's per-actor listing cap.
const MAX_ORGANIZATIONS = 100;

const OrganizationsResponseSchema = z.looseObject({
  organizations: z.array(z.looseObject({ organizationId: CollaborationOrganizationIdSchema })).max(MAX_ORGANIZATIONS),
});

/**
 * Returns the organization Share controls act in, or null when there is none.
 * Until an in-product organization switch exists (FR-024), only a single
 * unambiguous membership is active: picking one of several could share a
 * resource with the wrong organization. 401/403/404 mean this platform cannot
 * list memberships for the credential, which is also "no organization";
 * transient failures and malformed bodies reject so callers keep what they had.
 */
export async function fetchActiveOrganizationId(options: {
  fetchFn: FetchFn;
  origin: string;
  accessToken: string;
}): Promise<string | null> {
  const response = await options.fetchFn(new URL("/api/organizations", options.origin).toString(), {
    method: "GET",
    headers: { authorization: `Bearer ${options.accessToken}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(ORGANIZATIONS_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("organization listing rejected");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > ORGANIZATIONS_RESPONSE_LIMIT) {
    await response.body?.cancel();
    throw new Error("organization listing response too large");
  }
  const text = await readBoundedResponseText(response, ORGANIZATIONS_RESPONSE_LIMIT, "organization listing");
  const listing = OrganizationsResponseSchema.parse(JSON.parse(text));
  const organizationIds = new Set(listing.organizations.map((entry) => entry.organizationId));
  return organizationIds.size === 1 ? [...organizationIds][0]! : null;
}

interface ActiveOrganizationTrackerDeps {
  origin: string;
  fetchFn: FetchFn;
  now: () => number;
  onChanged: () => void;
}

interface ResolvedOrganization {
  userId: string;
  organizationId: string | null;
  resolvedAt: number;
}

interface OrganizationRefreshInput {
  userId: string;
  accessToken: string;
  /** Credential generation that started the lookup; lookups are never shared across generations. */
  generation: number;
  /** True while the credential that started the lookup is still the live one. */
  isCurrent: () => boolean;
}

/**
 * Holds the last resolved organization for one account. Membership belongs to
 * the account, so the value survives runtime switches but is never exposed for
 * a different user. Concurrent refreshes for the same credential generation
 * share one request; a lookup started with a replaced credential is dropped
 * when it lands, so it cannot overwrite a newer answer.
 */
export class ActiveOrganizationTracker {
  private resolved: ResolvedOrganization | null = null;
  private inflight: { userId: string; generation: number; promise: Promise<void> } | null = null;
  private readonly deps: ActiveOrganizationTrackerDeps;

  constructor(deps: ActiveOrganizationTrackerDeps) {
    this.deps = deps;
  }

  organizationFor(userId: string): string | null {
    return this.resolved?.userId === userId ? this.resolved.organizationId : null;
  }

  refresh(input: OrganizationRefreshInput & { maxAgeMs?: number }): Promise<void> {
    const resolved = this.resolved;
    if (resolved?.userId === input.userId && this.deps.now() - resolved.resolvedAt < (input.maxAgeMs ?? 0)) {
      return Promise.resolve();
    }
    const inflight = this.inflight;
    if (inflight?.userId === input.userId && inflight.generation === input.generation) return inflight.promise;
    const promise: Promise<void> = this.resolve(input).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { userId: input.userId, generation: input.generation, promise };
    return promise;
  }

  clear(): void {
    this.resolved = null;
    this.inflight = null;
  }

  private async resolve(input: OrganizationRefreshInput): Promise<void> {
    let organizationId: string | null;
    try {
      organizationId = await fetchActiveOrganizationId({
        fetchFn: this.deps.fetchFn,
        origin: this.deps.origin,
        accessToken: input.accessToken,
      });
    } catch (err: unknown) {
      console.warn("[auth] active organization unavailable:", err instanceof Error ? err.name : typeof err);
      return;
    }
    if (!input.isCurrent()) return;
    const previous = this.organizationFor(input.userId);
    this.resolved = { userId: input.userId, organizationId, resolvedAt: this.deps.now() };
    if (previous !== organizationId) this.deps.onChanged();
  }
}
