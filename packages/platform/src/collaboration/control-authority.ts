/**
 * Collaboration control authority (S03 / T017, T019).
 *
 * The platform issues control generations and denial fences and batches
 * membership assertions for active actors. A denial stays pending until
 * every affected home acknowledges a fence at or after it, or its lease
 * expires (every lease issued before the fence has lapsed by then). Pending
 * denials are pushed through a registered transport with bounded retries and
 * a dead-letter state; homes also pull assertions through
 * `/internal/organizations/access/resolve`. Evidence is never renewed from
 * receipt time and the selected organization is never authority.
 */
import {
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  type CollaborationControlAck,
  type CollaborationControlAssertion,
  type CollaborationDenial,
} from "@matrix-os/contracts";
import type { DenialRecord, DenialRuntimeRecord, PlatformOrganizationRepository } from "../organizations/repository.js";
import type { MembershipAssertion } from "../organizations/projection.js";

export const COLLABORATION_CONTROL_LEASE_MS = 25_000;
export const COLLABORATION_ASSERTION_BATCH_LIMIT = 100;
const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_DELIVERY_INTERVAL_MS = 1_000;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 60_000;

export type CollaborationControlTransport = (runtimeId: string, assertion: CollaborationControlAssertion) => Promise<void>;

export interface CollaborationControlAuthority {
  fence(input: { organizationId?: string; actorId?: string; scopeId?: string; generation: number }): Promise<CollaborationDenial & { denialId: string }>;
  acknowledge(authenticatedRuntimeId: string, ack: CollaborationControlAck): Promise<{ completedDenialIds: string[] }>;
  assertActors(runtimeId: string, actors: readonly { organizationId: string; actorId: string }[]): Promise<CollaborationControlAssertion[]>;
  describe(denialId: string): Promise<(CollaborationDenial & { denialId: string }) | null>;
  describeOutbox(denialId: string): Promise<DenialRuntimeRecord[]>;
  listPending(limit?: number): Promise<Array<CollaborationDenial & { denialId: string }>>;
  sweep(): Promise<{ completed: number; delivered: number }>;
  registerTransport(transport: CollaborationControlTransport): void;
  shutdown(): Promise<void>;
}

export function createCollaborationControlAuthority(options: {
  repository: PlatformOrganizationRepository;
  affectedRuntimes(input: { organizationId?: string; actorId?: string; scopeId?: string }): Promise<readonly string[]>;
  projection?: { assert(input: { organizationId: string; actorId: string; requestStartedAt: Date }): Promise<MembershipAssertion> };
  deliver?: CollaborationControlTransport;
  now?: () => Date;
  leaseMs?: number;
  sweepIntervalMs?: number;
  deliveryIntervalMs?: number;
  maxDeliveryAttempts?: number;
  startTimers?: boolean;
}): CollaborationControlAuthority {
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? COLLABORATION_CONTROL_LEASE_MS;
  const maxAttempts = options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
  let transport = options.deliver;
  let closed = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  let sweeping: Promise<unknown> | undefined;
  let delivering: Promise<unknown> | undefined;

  const toDenial = (record: DenialRecord): CollaborationDenial & { denialId: string } => ({
    denialId: record.denialId,
    ...(record.organizationId ? { organizationId: record.organizationId } : {}),
    ...(record.actorId ? { actorId: record.actorId } : {}),
    ...(record.scopeId ? { scopeId: record.scopeId } : {}),
    generation: record.generation,
    fencedAt: record.fencedAt,
    ackDeadline: record.ackDeadline,
    state: record.state,
    ...(record.acknowledgedAt ? { acknowledgedAt: record.acknowledgedAt } : {}),
  });

  const deliverDue = async (): Promise<number> => {
    if (closed || !transport) return 0;
    const current = now();
    const due = await options.repository.listDueDeliveries(current);
    let delivered = 0;
    for (const item of due) {
      if (closed) break;
      const { denialId, ...denial } = toDenial(item.denial);
      let ok = false;
      try {
        await transport(item.runtimeId, { protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, type: "denial", denial });
        ok = true;
      } catch (error: unknown) {
        console.warn("[collaboration-control] denial delivery failed", error instanceof Error ? error.name : "UnknownError");
      }
      const attempts = item.attempts + 1;
      const backoffMs = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 10));
      await options.repository.recordDeliveryAttempt({
        denialId,
        runtimeId: item.runtimeId,
        nextAttemptAt: new Date(current.getTime() + backoffMs),
        deadLetter: !ok && attempts >= maxAttempts,
      });
      if (ok) delivered += 1;
    }
    return delivered;
  };

  const guarded = (label: string, run: () => Promise<unknown>) => (): void => {
    if (closed) return;
    const holder = label === "sweep" ? sweeping : delivering;
    if (holder) return;
    const promise = run().catch((error: unknown) => {
      console.warn(`[collaboration-control] ${label} failed`, error instanceof Error ? error.name : "UnknownError");
    }).finally(() => {
      if (label === "sweep") sweeping = undefined; else delivering = undefined;
    });
    if (label === "sweep") sweeping = promise; else delivering = promise;
  };

  if (options.startTimers) {
    const sweepTimer = setInterval(guarded("sweep", () => options.repository.completeExpiredDenials(now())), options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const deliveryTimer = setInterval(guarded("delivery", deliverDue), options.deliveryIntervalMs ?? DEFAULT_DELIVERY_INTERVAL_MS);
    sweepTimer.unref?.();
    deliveryTimer.unref?.();
    timers.push(sweepTimer, deliveryTimer);
  }

  return {
    async fence(input) {
      if (closed) throw new Error("Control authority is shutting down");
      const fencedAt = now();
      const runtimeIds = await options.affectedRuntimes(input);
      const record = await options.repository.createDenial({
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
        generation: input.generation,
        fencedAt,
        ackDeadline: new Date(fencedAt.getTime() + leaseMs),
        runtimeIds,
      });
      return toDenial(record);
    },
    async acknowledge(authenticatedRuntimeId, ack) {
      if (ack.runtimeId !== authenticatedRuntimeId) throw new Error("Acknowledgement runtime does not match the authenticated runtime");
      const fenceAt = new Date(ack.fenceAt);
      if (!Number.isFinite(fenceAt.getTime())) throw new Error("Acknowledgement fence time is invalid");
      const completedDenialIds = await options.repository.acknowledgeRuntime({ runtimeId: ack.runtimeId, fenceAt, acknowledgedAt: now() });
      return { completedDenialIds };
    },
    async assertActors(_runtimeId, actors) {
      if (actors.length > COLLABORATION_ASSERTION_BATCH_LIMIT) throw new Error("Assertion batch exceeds the limit");
      if (!options.projection) throw new Error("No membership projection is registered");
      const requestStartedAt = now();
      const unique = new Map<string, { organizationId: string; actorId: string }>();
      for (const actor of actors) unique.set(`${actor.organizationId}\u0000${actor.actorId}`, actor);
      const results = await Promise.all([...unique.values()].map(async (actor) => {
        const assertion = await options.projection!.assert({ ...actor, requestStartedAt });
        return {
          protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
          type: "membership_assertion" as const,
          organizationId: actor.organizationId,
          actorId: actor.actorId,
          membershipEpoch: String(assertion.membershipEpoch),
          member: assertion.member,
          requestStartedAt: assertion.requestStartedAt.toISOString(),
          expiresAt: assertion.expiresAt.toISOString(),
        } satisfies CollaborationControlAssertion;
      }));
      return results;
    },
    async describe(denialId) {
      const record = await options.repository.getDenial(denialId);
      return record ? toDenial(record) : null;
    },
    describeOutbox(denialId) {
      return options.repository.listDenialRuntimes(denialId);
    },
    async listPending(limit) {
      return (await options.repository.listPendingDenials(limit)).map(toDenial);
    },
    async sweep() {
      const completed = await options.repository.completeExpiredDenials(now());
      const delivered = await deliverDue();
      return { completed, delivered };
    },
    registerTransport(next) {
      if (transport) throw new Error("A control transport is already registered");
      transport = next;
    },
    async shutdown() {
      closed = true;
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      await Promise.allSettled([sweeping ?? Promise.resolve(), delivering ?? Promise.resolve()]);
    },
  };
}
