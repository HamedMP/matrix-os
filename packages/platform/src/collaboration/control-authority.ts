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
import { randomUUID } from "node:crypto";
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
const DEFAULT_CLAIM_LEASE_MS = 30_000;

export type CollaborationControlTransport = (runtimeId: string, assertion: CollaborationControlAssertion) => Promise<void>;

export interface CollaborationControlAuthority {
  fence(input: { organizationId?: string; actorId?: string; scopeId?: string; generation: number }): Promise<CollaborationDenial & { denialId: string }>;
  acknowledge(authenticatedRuntimeId: string, ack: CollaborationControlAck): Promise<{ completedDenialIds: string[] }>;
  assertActors(runtimeId: string, actors: readonly { organizationId: string; actorId: string }[]): Promise<CollaborationControlAssertion[]>;
  describe(denialId: string): Promise<(CollaborationDenial & { denialId: string }) | null>;
  describeOutbox(denialId: string): Promise<DenialRuntimeRecord[]>;
  listPending(limit?: number): Promise<Array<CollaborationDenial & { denialId: string }>>;
  /** Turns durable revocation intents (written with the membership transition) into denial fences; retried with backoff, dead-lettered after repeated failure. */
  drainRevocations(): Promise<{ fenced: number; failed: number }>;
  sweep(): Promise<{ completed: number; delivered: number; fenced: number }>;
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
  /** How long a claimed revocation intent stays owned by one drainer before another may retry it. */
  claimLeaseMs?: number;
  /** Intents one drain pass claims at once (bounded 1–1000). */
  claimBatchSize?: number;
  drainerId?: string;
  startTimers?: boolean;
}): CollaborationControlAuthority {
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? COLLABORATION_CONTROL_LEASE_MS;
  const maxAttempts = options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
  const claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  const drainerId = options.drainerId ?? randomUUID();
  const claimBatchSize = Math.min(Math.max(options.claimBatchSize ?? 100, 1), 1_000);
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
    const sweepTimer = setInterval(guarded("sweep", async () => {
      await drainRevocations();
      await options.repository.completeExpiredDenials(now());
    }), options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const deliveryTimer = setInterval(guarded("delivery", deliverDue), options.deliveryIntervalMs ?? DEFAULT_DELIVERY_INTERVAL_MS);
    sweepTimer.unref?.();
    deliveryTimer.unref?.();
    timers.push(sweepTimer, deliveryTimer);
  }

  const drainRevocations = async (): Promise<{ fenced: number; failed: number }> => {
    if (closed) return { fenced: 0, failed: 0 };
    const current = now();
    // The claim statement is the only writer that increments attempts, so a drainer that
    // crashes after claiming still consumed one attempt and its lease expires for a retry.
    const claimed = await options.repository.claimDueRevocationIntents({ now: current, drainerId, leaseMs: claimLeaseMs, maxAttempts, limit: claimBatchSize });
    let fenced = 0;
    let failed = 0;
    for (const intent of claimed) {
      if (closed) break;
      try {
        // Runtime discovery happens outside the transaction; the denial insert (keyed by the
        // intent id, ON CONFLICT DO NOTHING) and the intent completion commit together, so a
        // retry after a crash at any point finds the same denial and never creates a second one.
        const fencedAt = now();
        const runtimeIds = await options.affectedRuntimes({ organizationId: intent.organizationId, actorId: intent.actorId });
        await options.repository.transaction(async (repo) => {
          await repo.createDenial({
            denialId: intent.intentId,
            organizationId: intent.organizationId,
            actorId: intent.actorId,
            generation: Math.max(1, intent.membershipEpoch),
            fencedAt,
            ackDeadline: new Date(fencedAt.getTime() + leaseMs),
            runtimeIds,
          });
          const completed = await repo.completeRevocationIntent({ intentId: intent.intentId, denialId: intent.intentId, drainerId });
          if (!completed) console.warn("[collaboration-control] revocation intent completed by another drainer");
        });
        fenced += 1;
      } catch (error: unknown) {
        console.warn("[collaboration-control] revocation fence failed", error instanceof Error ? error.name : "UnknownError");
        try {
          await options.repository.releaseRevocationIntent({ intentId: intent.intentId, drainerId });
        } catch (releaseError: unknown) {
          console.warn("[collaboration-control] revocation intent release failed", releaseError instanceof Error ? releaseError.name : "UnknownError");
        }
        failed += 1;
      }
    }
    return { fenced, failed };
  };

  const fence: CollaborationControlAuthority["fence"] = async (input) => {
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
  };

  return {
    fence,
    drainRevocations,
    async acknowledge(authenticatedRuntimeId, ack) {
      if (ack.runtimeId !== authenticatedRuntimeId) throw new Error("Acknowledgement runtime does not match the authenticated runtime");
      const fenceAt = new Date(ack.fenceAt);
      if (!Number.isFinite(fenceAt.getTime())) throw new Error("Acknowledgement fence time is invalid");
      const completedDenialIds = await options.repository.acknowledgeRuntime({
        runtimeId: ack.runtimeId, fenceAt, generation: ack.authorityGeneration, acknowledgedAt: now(),
      });
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
          aiSubmission: assertion.aiSubmission,
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
      const { fenced } = await drainRevocations();
      const completed = await options.repository.completeExpiredDenials(now());
      const delivered = await deliverDue();
      return { completed, delivered, fenced };
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
