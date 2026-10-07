/**
 * Membership projection consumed by the S20 organization precondition and
 * the identifier resolver (S03 / T016, T019).
 *
 * Positive evidence needs two things: an active membership row and a
 * recent upstream verification of that organization. Evidence expires at a
 * fixed deadline anchored to the upstream request start, never to receipt
 * time. Reconciliations are coalesced per organization, run on a recurring
 * timer for recently active organizations (bounded, LRU). A stale read for a
 * known active membership awaits fresh coalesced verification, and an upstream
 * failure simply lets the verification age out, so outages fail closed.
 */
import type { EndedMembership, PlatformOrganizationRepository } from "./repository.js";
import type { MembershipSnapshot, OrganizationSnapshot } from "./roles.js";

export interface ClerkOrganizationUpstream {
  listOrganizationsForActor?(actorId: string): Promise<string[]>;
  listMembers(organizationId: string): Promise<{ organization: OrganizationSnapshot; members: MembershipSnapshot[] }>;
}

export interface MembershipAssertion {
  member: boolean;
  /** Projected organization policy; owner-only unless the metadata literally says "members". */
  aiSubmission: "members" | "owner_only";
  membershipEpoch: number;
  requestStartedAt: Date;
  expiresAt: Date;
}

export interface OrganizationMembershipProjection {
  discoverOrganizationsForActor(actorId: string): Promise<{ complete: boolean }>;
  assert(input: { organizationId: string; actorId: string; requestStartedAt: Date }): Promise<MembershipAssertion>;
  isCurrentMember(input: { organizationId: string; actorId: string }): Promise<boolean>;
  touch(organizationId: string): void;
  reconcile(organizationId: string): Promise<{ verified: boolean; endedMemberships: EndedMembership[] }>;
  describe(): { tracked: number; inflight: number; upstream: boolean };
  shutdown(): Promise<void>;
}

export class OrganizationRefreshUnavailableError extends Error {
  constructor() { super("Organization refresh unavailable"); this.name = "OrganizationRefreshUnavailableError"; }
}

export const ORGANIZATION_EVIDENCE_TTL_MS = 20_000;
export const ORGANIZATION_POSITIVE_EVIDENCE_MAX_AGE_MS = 60_000;
export const ORGANIZATION_REFRESH_INTERVAL_MS = 10_000;
const CLOCK_SKEW_MS = 5_000;
const ACTIVE_WINDOW_MS = 5 * 60_000;
const MAX_REFRESH_CONCURRENCY = 4;
export const MAX_INFLIGHT_RECONCILIATIONS = 64;
const FAILED_REFRESH_RETRY_MS = 10_000;

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
  // TTL plus LRU eviction bounds negative retry state without renewing evidence.
  const retryAfter = new Map<string, number>();
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
    const current = now().getTime();
    for (const [id, deadline] of retryAfter) {
      if (deadline <= current) retryAfter.delete(id);
    }
    if ((retryAfter.get(organizationId) ?? 0) > current) return { verified: false, endedMemberships: [] };
    if (inflight.size >= MAX_INFLIGHT_RECONCILIATIONS) {
      // Capacity is availability, not membership evidence. Reads fail closed
      // with an unavailable response rather than silently hiding valid organizations.
      console.warn("[organizations] reconciliation deferred: too many in flight");
      throw new OrganizationRefreshUnavailableError();
    }
    const promise = reconcileNow(organizationId).then((result) => {
      if (result.verified) retryAfter.delete(organizationId);
      else {
        retryAfter.delete(organizationId);
        retryAfter.set(organizationId, now().getTime() + FAILED_REFRESH_RETRY_MS);
        while (retryAfter.size > maxTracked) retryAfter.delete(retryAfter.keys().next().value!);
      }
      return result;
    }).finally(() => { inflight.delete(organizationId); });
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

  const evaluate = async (organizationId: string, actorId: string): Promise<{ member: boolean; membershipEpoch: number; aiSubmission: "members" | "owner_only" }> => {
    touch(organizationId);
    let [organization, membership] = await Promise.all([
      options.repository.getOrganization(organizationId),
      options.repository.getMembership({ organizationId, actorId }),
    ]);
    // Idle Cloud Run instances cannot rely on timers to refresh positive evidence.
    // Only a previously known active membership may request this bounded,
    // coalesced upstream verification; unknown actors never trigger a lookup.
    if (options.upstream && organization?.lifecycle === "active" && membership?.state === "active"
      && (!organization.verifiedAt || now().getTime() - organization.verifiedAt.getTime() > maxAgeMs)) {
      await reconcile(organizationId);
      [organization, membership] = await Promise.all([
        options.repository.getOrganization(organizationId),
        options.repository.getMembership({ organizationId, actorId }),
      ]);
    }
    const epoch = membership?.membershipEpoch ?? organization?.membershipEpoch ?? 0;
    const aiSubmission = organization?.aiSubmission ?? "owner_only";
    if (!organization || organization.lifecycle !== "active" || !organization.verifiedAt) return { member: false, membershipEpoch: epoch, aiSubmission };
    if (now().getTime() - organization.verifiedAt.getTime() > maxAgeMs) return { member: false, membershipEpoch: epoch, aiSubmission };
    return { member: membership?.state === "active", membershipEpoch: epoch, aiSubmission };
  };

  return {
    async discoverOrganizationsForActor(actorId) {
      if (closed || !options.upstream?.listOrganizationsForActor) return { complete: false };
      let discovered: string[];
      try {
        discovered = await options.upstream.listOrganizationsForActor(actorId);
      } catch (error: unknown) {
        console.warn("[organizations] actor organization discovery failed", error instanceof Error ? error.name : "UnknownError");
        return { complete: false };
      }
      const known = await options.repository.listOrganizationsForActorPage(actorId);
      const organizationIds = [...new Set([
        ...discovered,
        ...known.organizations.map((entry) => entry.organization.organizationId),
      ])];
      let complete = known.complete;
      for (let index = 0; index < organizationIds.length; index += MAX_REFRESH_CONCURRENCY) {
        const results = await Promise.all(organizationIds.slice(index, index + MAX_REFRESH_CONCURRENCY).map((organizationId) => reconcile(organizationId)));
        if (results.some((result) => !result.verified)) complete = false;
      }
      return { complete };
    },
    async assert(input) {
      const current = now().getTime();
      const startedAt = Math.min(input.requestStartedAt.getTime(), current + CLOCK_SKEW_MS);
      const requestStartedAt = new Date(startedAt);
      const { member, membershipEpoch, aiSubmission } = closed
        ? { member: false, membershipEpoch: 0, aiSubmission: "owner_only" as const }
        : await evaluate(input.organizationId, input.actorId);
      return { member, aiSubmission, membershipEpoch, requestStartedAt, expiresAt: new Date(startedAt + evidenceTtlMs) };
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
      retryAfter.clear();
    },
  };
}
