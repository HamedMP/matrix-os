/**
 * Membership projection consumed by the S20 organization precondition and
 * the identifier resolver (S03 / T016, T019).
 *
 * Positive evidence needs two things: an active membership row and a
 * recent upstream verification of that organization. Evidence expires at a
 * fixed deadline anchored to the upstream request start, never to receipt
 * time. Reconciliations are coalesced per organization, run on a recurring
 * timer for recently active organizations (bounded, LRU), and an upstream
 * failure simply lets the verification age out, so outages fail closed.
 */
import type { EndedMembership, PlatformOrganizationRepository } from "./repository.js";
import type { MembershipSnapshot, OrganizationSnapshot } from "./roles.js";

export interface ClerkOrganizationUpstream {
  listMembers(organizationId: string): Promise<{ organization: OrganizationSnapshot; members: MembershipSnapshot[] }>;
}

export interface MembershipAssertion {
  member: boolean;
  membershipEpoch: number;
  requestStartedAt: Date;
  expiresAt: Date;
}

export interface OrganizationMembershipProjection {
  assert(input: { organizationId: string; actorId: string; requestStartedAt: Date }): Promise<MembershipAssertion>;
  isCurrentMember(input: { organizationId: string; actorId: string }): Promise<boolean>;
  touch(organizationId: string): void;
  reconcile(organizationId: string): Promise<{ verified: boolean; endedMemberships: EndedMembership[] }>;
  describe(): { tracked: number; inflight: number; upstream: boolean };
  shutdown(): Promise<void>;
}

export const ORGANIZATION_EVIDENCE_TTL_MS = 20_000;
export const ORGANIZATION_POSITIVE_EVIDENCE_MAX_AGE_MS = 60_000;
export const ORGANIZATION_REFRESH_INTERVAL_MS = 10_000;
const CLOCK_SKEW_MS = 5_000;
const ACTIVE_WINDOW_MS = 5 * 60_000;
const MAX_REFRESH_CONCURRENCY = 4;

export function createOrganizationMembershipProjection(options: {
  repository: PlatformOrganizationRepository;
  upstream?: ClerkOrganizationUpstream;
  now?: () => Date;
  evidenceTtlMs?: number;
  positiveEvidenceMaxAgeMs?: number;
  refreshIntervalMs?: number;
  maxTrackedOrganizations?: number;
  startTimers?: boolean;
  onMembershipEnded?: (ended: readonly EndedMembership[], membershipEpoch: number) => Promise<void>;
}): OrganizationMembershipProjection {
  const now = options.now ?? (() => new Date());
  const evidenceTtlMs = options.evidenceTtlMs ?? ORGANIZATION_EVIDENCE_TTL_MS;
  const maxAgeMs = options.positiveEvidenceMaxAgeMs ?? ORGANIZATION_POSITIVE_EVIDENCE_MAX_AGE_MS;
  const maxTracked = options.maxTrackedOrganizations ?? 1_000;
  const tracked = new Map<string, number>();
  const inflight = new Map<string, Promise<{ verified: boolean; endedMemberships: EndedMembership[] }>>();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;

  const touch = (organizationId: string): void => {
    if (closed) return;
    tracked.delete(organizationId);
    tracked.set(organizationId, now().getTime());
    while (tracked.size > maxTracked) {
      const oldest = tracked.keys().next().value;
      if (oldest === undefined) break;
      tracked.delete(oldest);
    }
  };

  const reconcileNow = async (organizationId: string) => {
    if (!options.upstream) return { verified: false, endedMemberships: [] as EndedMembership[] };
    let snapshot: Awaited<ReturnType<ClerkOrganizationUpstream["listMembers"]>>;
    try {
      snapshot = await options.upstream.listMembers(organizationId);
    } catch (error: unknown) {
      console.warn("[organizations] upstream reconciliation failed", error instanceof Error ? error.name : "UnknownError");
      return { verified: false, endedMemberships: [] as EndedMembership[] };
    }
    if (snapshot.organization.organizationId !== organizationId) {
      console.warn("[organizations] upstream returned a different organization");
      return { verified: false, endedMemberships: [] as EndedMembership[] };
    }
    const result = await options.repository.reconcileOrganization(snapshot, now());
    if (result.endedMemberships.length > 0) {
      try {
        await options.onMembershipEnded?.(result.endedMemberships, result.membershipEpoch);
      } catch (error: unknown) {
        console.warn("[organizations] membership-ended handler failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
    return { verified: true, endedMemberships: result.endedMemberships };
  };

  const reconcile: OrganizationMembershipProjection["reconcile"] = async (organizationId) => {
    if (closed) return { verified: false, endedMemberships: [] };
    const existing = inflight.get(organizationId);
    if (existing) return existing;
    const promise = reconcileNow(organizationId).finally(() => { inflight.delete(organizationId); });
    inflight.set(organizationId, promise);
    return promise;
  };

  const sweep = async (): Promise<void> => {
    if (closed) return;
    const cutoff = now().getTime() - ACTIVE_WINDOW_MS;
    const due = [...tracked.entries()].filter(([, touchedAt]) => touchedAt >= cutoff).map(([organizationId]) => organizationId);
    for (let index = 0; index < due.length; index += MAX_REFRESH_CONCURRENCY) {
      await Promise.all(due.slice(index, index + MAX_REFRESH_CONCURRENCY).map((organizationId) => reconcile(organizationId)));
    }
  };

  if (options.startTimers) {
    timer = setInterval(() => {
      if (sweeping) return;
      sweeping = sweep().catch((error: unknown) => {
        console.warn("[organizations] recurring reconciliation failed", error instanceof Error ? error.name : "UnknownError");
      }).finally(() => { sweeping = undefined; });
    }, options.refreshIntervalMs ?? ORGANIZATION_REFRESH_INTERVAL_MS);
    timer.unref?.();
  }

  const evaluate = async (organizationId: string, actorId: string): Promise<{ member: boolean; membershipEpoch: number }> => {
    touch(organizationId);
    const [organization, membership] = await Promise.all([
      options.repository.getOrganization(organizationId),
      options.repository.getMembership({ organizationId, actorId }),
    ]);
    const epoch = membership?.membershipEpoch ?? organization?.membershipEpoch ?? 0;
    if (!organization || organization.lifecycle !== "active" || !organization.verifiedAt) return { member: false, membershipEpoch: epoch };
    if (now().getTime() - organization.verifiedAt.getTime() > maxAgeMs) return { member: false, membershipEpoch: epoch };
    return { member: membership?.state === "active", membershipEpoch: epoch };
  };

  return {
    async assert(input) {
      const current = now().getTime();
      const startedAt = Math.min(input.requestStartedAt.getTime(), current + CLOCK_SKEW_MS);
      const requestStartedAt = new Date(startedAt);
      const { member, membershipEpoch } = closed ? { member: false, membershipEpoch: 0 } : await evaluate(input.organizationId, input.actorId);
      return { member, membershipEpoch, requestStartedAt, expiresAt: new Date(startedAt + evidenceTtlMs) };
    },
    async isCurrentMember(input) {
      if (closed) return false;
      return (await evaluate(input.organizationId, input.actorId)).member;
    },
    touch,
    reconcile,
    describe() {
      return { tracked: tracked.size, inflight: inflight.size, upstream: Boolean(options.upstream) };
    },
    async shutdown() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await Promise.allSettled([...inflight.values(), sweeping ?? Promise.resolve()]);
      tracked.clear();
    },
  };
}
