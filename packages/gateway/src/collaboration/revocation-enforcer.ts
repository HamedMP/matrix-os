/**
 * S07 / T039: revocation enforcement on lease loss.
 *
 * When a direct session ends because the platform denied the actor, the
 * organization evidence expired, or the lease was revoked, the actor's
 * terminal controller is released, every sandbox runtime bound to the actor
 * in that scope is stopped, and further terminal input is refused until a
 * fresh session is admitted or the block ages out. A normal close is not a
 * revocation. Both registries are bounded.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DirectSessionEndReason } from "./direct-sessions.js";
import type { TerminalControlCoordinator } from "./terminal-control.js";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "./database.js";
import { ScopeRuntimeClientError } from "./scope-runtime-client.js";
import {
  appendMutationRecords,
  completeAcceptedOperation,
  jsonb,
  OPERATION_RETENTION_MS,
  parseJson,
} from "./repository-shared.js";

const DEFAULT_TTL_MS = 20 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 4_096;
/** No sandboxed shared run may outlive this; an older binding is stale and its runtime is stopped. */
const DEFAULT_RUNTIME_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1_000;
const RUNTIME_HANDLE = /^runtime_[a-f0-9]{32}$/;
const MAX_ORGANIZATION_PROJECTS = 1_000;
const MAX_PROJECT_SCOPES = 100_000;
const OWNER_DEPARTURE_OPERATION = "membership.departure_cleanup";
const OwnerDepartureCleanupSchema = z.object({
  scopeIds: z.array(z.uuid()).min(1).max(MAX_PROJECT_SCOPES + 1),
  revision: z.number().int().positive(),
}).strict();
type CollaborationExecutor = Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>;

export type { DirectSessionEndReason };
/** An exhausted action budget belongs to one session, not every session held by the actor. */
const REVOKING_REASONS: ReadonlySet<DirectSessionEndReason> = new Set(["expired", "denied", "revoked"]);

interface RuntimeBinding {
  scopeId: string;
  actorId: string;
  runtimeHandle: string;
  /** Abort paid inference synchronously before waiting for a physical stop. */
  onStop?: () => void;
}

/**
 * Bounded registry of sandbox runtimes bound to (scope, actor); stops them on
 * revocation. A binding the registry can no longer track is never dropped
 * silently: at capacity the oldest binding is evicted and its runtime stopped,
 * and a binding older than the maximum run age is swept the same way, so a
 * runtime never outlives its revocation tracking (fail closed).
 */
export class SandboxRuntimeRegistry {
  private readonly bindings = new Map<string, RuntimeBinding & { boundAt: number; stopNotified: boolean }>();
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    client: { stopRuntime(input: { runtimeHandle: string }): Promise<unknown> };
    maxEntries?: number;
    /** Oldest a binding may be before its runtime is stopped and the entry evicted. */
    maxAgeMs?: number;
    sweepIntervalMs?: number;
    now?: () => Date;
    /** Periodic stale sweep; disable only in tests that call `sweep()` directly. */
    startTimer?: boolean;
  }) {
    this.maxEntries = boundedInteger(options.maxEntries ?? 256, 1, 256, "registry capacity");
    this.maxAgeMs = boundedInteger(options.maxAgeMs ?? DEFAULT_RUNTIME_MAX_AGE_MS, 1_000, 7 * 24 * 60 * 60 * 1_000, "runtime max age");
    this.now = options.now ?? (() => new Date());
    const sweepIntervalMs = boundedInteger(options.sweepIntervalMs ?? DEFAULT_RUNTIME_SWEEP_INTERVAL_MS, 1_000, 60 * 60 * 1_000, "runtime sweep interval");
    if (options.startTimer !== false) {
      this.sweepTimer = setInterval(() => { this.sweep(); }, sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  get size(): number {
    return this.bindings.size;
  }

  bind(binding: RuntimeBinding): void {
    if (!RUNTIME_HANDLE.test(binding.runtimeHandle)) throw new Error("Invalid sandbox runtime handle");
    if (this.bindings.has(binding.runtimeHandle)) return;
    this.sweep();
    while (this.bindings.size >= this.maxEntries) {
      const oldest = this.bindings.keys().next().value;
      if (oldest === undefined) break;
      console.warn("[collaboration-revocation] sandbox runtime registry at capacity; stopping oldest runtime");
      this.evict(oldest);
    }
    this.bindings.set(binding.runtimeHandle, { ...binding, boundAt: this.now().getTime(), stopNotified: false });
  }

  release(runtimeHandle: string): void {
    this.bindings.delete(runtimeHandle);
  }

  /** Stops and evicts every binding older than the maximum run age; returns how many were evicted. */
  sweep(): number {
    const cutoff = this.now().getTime() - this.maxAgeMs;
    let evicted = 0;
    for (const [runtimeHandle, binding] of [...this.bindings]) {
      if (binding.boundAt > cutoff) continue;
      console.warn("[collaboration-revocation] sandbox runtime outlived the maximum run age; stopping it");
      this.evict(runtimeHandle);
      evicted += 1;
    }
    return evicted;
  }

  async stopForActor(scopeId: string, actorId: string): Promise<number> {
    const matching = [...this.bindings.values()].filter(binding => binding.scopeId === scopeId && binding.actorId === actorId);
    return this.stopTracked(matching);
  }

  async stopForScope(scopeId: string): Promise<number> {
    const matching = [...this.bindings.values()].filter(binding => binding.scopeId === scopeId);
    return this.stopTracked(matching);
  }

  /** Revokes and stops every shared runtime before owner provider authority changes. */
  async stopAll(): Promise<number> {
    const all = [...this.bindings.values()];
    return this.stopTracked(all);
  }

  private async stopTracked(
    bindings: Array<RuntimeBinding & { boundAt: number; stopNotified: boolean }>,
  ): Promise<number> {
    // Revoke all model/frame authority before any asynchronous worker stop.
    for (const binding of bindings) {
      if (binding.stopNotified) continue;
      binding.stopNotified = true;
      this.notifyStop(binding);
    }
    let stopped = 0;
    let failed = false;
    for (const binding of bindings) {
      try {
        await this.options.client.stopRuntime({ runtimeHandle: binding.runtimeHandle });
        if (this.bindings.get(binding.runtimeHandle) === binding) {
          this.bindings.delete(binding.runtimeHandle);
        }
        stopped += 1;
      } catch (error: unknown) {
        if (error instanceof ScopeRuntimeClientError && error.code === "runtime_not_found") {
          if (this.bindings.get(binding.runtimeHandle) === binding) {
            this.bindings.delete(binding.runtimeHandle);
          }
          stopped += 1;
          continue;
        }
        failed = true;
        console.warn("[collaboration-revocation] sandbox runtime stop failed",
          error instanceof Error ? error.name : "UnknownError");
      }
    }
    if (failed) throw new Error("Sandbox runtime stop failed");
    return stopped;
  }

  /** Waits for eviction stops started so far (tests and shutdown). */
  async settle(): Promise<void> {
    await this.inFlight;
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private notifyStop(binding: RuntimeBinding): void {
    try { binding.onStop?.(); }
    catch (error: unknown) {
      console.warn("[collaboration-revocation] inference cancellation failed", error instanceof Error ? error.name : "UnknownError");
    }
  }

  private evict(runtimeHandle: string): void {
    const binding = this.bindings.get(runtimeHandle);
    this.bindings.delete(runtimeHandle);
    if (binding) this.notifyStop(binding);
    const stop = this.options.client.stopRuntime({ runtimeHandle }).then(() => undefined, (error: unknown) => {
      console.warn("[collaboration-revocation] evicted sandbox runtime stop failed",
        error instanceof Error ? error.name : "UnknownError");
    });
    this.inFlight = this.inFlight.then(() => stop);
  }
}

export class CollaborationRevocationEnforcer {
  private readonly blocked = new Map<string, number>();
  private readonly pending = new Map<Promise<void>, true>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxPending: number;
  private inFlight = 0;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;

  constructor(private readonly options: {
    control: Pick<TerminalControlCoordinator, "invalidateActor">;
    runtimes?: Pick<SandboxRuntimeRegistry, "stopForActor">;
    now?: () => Date;
    ttlMs?: number;
    maxEntries?: number;
    maxPending?: number;
  }) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = boundedInteger(options.ttlMs ?? DEFAULT_TTL_MS, 1_000, 24 * 60 * 60 * 1_000, "revocation ttl");
    this.maxEntries = boundedInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 1, 65_536, "revocation capacity");
    this.maxPending = boundedInteger(options.maxPending ?? 256, 1, 4_096, "pending revocation capacity");
  }

  get size(): number {
    return this.blocked.size;
  }

  get pendingSize(): number {
    return this.pending.size;
  }

  /** Plug into `DirectSessionService.onEnded`. */
  onSessionEnded(session: { scopeId: string; actorId: string; organizationId?: string }, reason: DirectSessionEndReason): void {
    if (!REVOKING_REASONS.has(reason)) return;
    if (this.inFlight++ === 0) this.idle = new Promise((resolve) => { this.resolveIdle = resolve; });
    const operation = this.revoke(session.scopeId, session.actorId).catch((error: unknown) => {
      console.warn("[collaboration-revocation] enforcement failed",
        error instanceof Error ? error.name : "UnknownError");
    });
    // Stop calls continue even if their bookkeeping entry is evicted. The
    // runtime client has its own request cap and timeout; the counter keeps
    // settle() aware of evicted work without retaining every promise.
    if (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest) this.pending.delete(oldest);
    }
    this.pending.set(operation, true);
    void operation.finally(() => {
      this.pending.delete(operation);
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        this.resolveIdle?.();
        this.resolveIdle = undefined;
      }
    });
  }

  async revoke(scopeId: string, actorId: string): Promise<void> {
    this.block(scopeId, actorId);
    this.options.control.invalidateActor(scopeId, actorId);
    if (this.options.runtimes) await this.options.runtimes.stopForActor(scopeId, actorId);
  }

  /** A fresh, verified session admission lifts the block for that actor and scope. */
  admit(scopeId: string, actorId: string): void {
    this.blocked.delete(keyFor(scopeId, actorId));
  }

  isRevoked(scopeId: string, actorId: string): boolean {
    const key = keyFor(scopeId, actorId);
    const until = this.blocked.get(key);
    if (until === undefined) return false;
    if (until <= this.now().getTime()) {
      this.blocked.delete(key);
      return false;
    }
    return true;
  }

  /** Waits for in-flight enforcement (tests and shutdown). */
  async settle(): Promise<void> {
    await this.idle;
  }

  private block(scopeId: string, actorId: string): void {
    const key = keyFor(scopeId, actorId);
    this.blocked.delete(key);
    const now = this.now().getTime();
    for (const [existing, until] of this.blocked) {
      if (until <= now) this.blocked.delete(existing);
    }
    while (this.blocked.size >= this.maxEntries) {
      const oldest = this.blocked.keys().next().value;
      if (oldest === undefined) break;
      this.blocked.delete(oldest);
    }
    this.blocked.set(key, now + this.ttlMs);
  }
}

/**
 * Expands an organization membership loss or project unshare into the exact
 * project scope set that must be drained. Database lifecycle/membership state
 * is the authorization fence; this coordinator removes stale live authority.
 */
export class ProjectAccessRevocationEnforcer {
  constructor(private readonly options: {
    db: Kysely<OwnerCollaborationDatabase>;
    sessions: { revoke(input: { organizationId?: string; actorId?: string; scopeId?: string }): string[] };
    drainScope(scopeId: string, actorId?: string): Promise<void>;
  }) {}

  async membershipEnded(input: { organizationId: string; actorId: string }): Promise<void> {
    const { projects, children, ownerCleanups } = await this.options.db.transaction().execute(async (trx) => {
      const pendingCleanupRows = await trx.selectFrom("collaboration_operations as operation")
        .innerJoin("collaboration_scopes as scope", "scope.id", "operation.scope_id")
        .select(["operation.scope_id", "operation.client_request_id", "operation.result_ref"])
        .where("operation.actor_id", "=", input.actorId)
        .where("operation.operation_kind", "=", OWNER_DEPARTURE_OPERATION)
        .where("operation.status", "=", "accepted")
        .where("scope.organization_id", "=", input.organizationId)
        .where("scope.deleted_at", "is", null)
        .orderBy("operation.scope_id")
        .limit(MAX_ORGANIZATION_PROJECTS + 1)
        .execute();
      if (pendingCleanupRows.length > MAX_ORGANIZATION_PROJECTS) {
        throw new Error("Owner project cleanup capacity exceeded");
      }
      const ownerCleanups = pendingCleanupRows.map((row) => ({
        projectScopeId: row.scope_id,
        operationId: row.client_request_id,
        ...OwnerDepartureCleanupSchema.parse(parseJson(row.result_ref)),
      }));
      const projects = await trx.selectFrom("collaboration_scopes")
        .selectAll()
        .where("organization_id", "=", input.organizationId)
        .where("kind", "=", "project")
        .where("lifecycle", "in", ["preparing", "shared", "archived", "recovering"])
        .where("deleted_at", "is", null)
        .orderBy("id")
        .limit(MAX_ORGANIZATION_PROJECTS + 1)
        .forUpdate()
        .execute();
      if (projects.length > MAX_ORGANIZATION_PROJECTS) {
        throw new Error("Organization project revocation capacity exceeded");
      }
      const children = projects.length === 0 ? [] : await trx.selectFrom("collaboration_scopes")
        .selectAll()
        .where("parent_scope_id", "in", projects.map((project) => project.id))
        .where("membership_mode", "=", "inherited")
        .where("deleted_at", "is", null)
        .orderBy("id")
        .limit(MAX_PROJECT_SCOPES + 1)
        .forUpdate()
        .execute();
      if (children.length > MAX_PROJECT_SCOPES) {
        throw new Error("Project scope revocation capacity exceeded");
      }
      const committedAt = new Date().toISOString();
      for (const project of projects) {
        if (project.owner_id !== input.actorId) continue;
        const updated = await trx.updateTable("collaboration_scopes").set({
          lifecycle: "private",
          revision: sql<number>`revision + 1`,
          auth_epoch: sql<number>`auth_epoch + 1`,
          updated_at: committedAt,
        }).where("id", "=", project.id)
          .where("revision", "=", Number(project.revision))
          .where("lifecycle", "=", project.lifecycle)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw new Error("Owner project departure fence changed");
        await trx.updateTable("collaboration_transitions").set({
          status: "failed",
          error_code: "owner_membership_ended",
          updated_at: committedAt,
        }).where("scope_id", "=", project.id)
          .where("status", "in", ["prepared", "staging", "fenced", "committing", "recovering"])
          .execute();
        const ownedChildren = children.filter((child) => child.parent_scope_id === project.id);
        if (ownedChildren.length > 0) {
          const updatedChildren = await trx.updateTable("collaboration_scopes").set({
            lifecycle: "private",
            revision: sql<number>`revision + 1`,
            auth_epoch: sql<number>`auth_epoch + 1`,
            updated_at: committedAt,
          }).where("id", "in", ownedChildren.map((child) => child.id))
            .returning("id")
            .execute();
          if (updatedChildren.length !== ownedChildren.length) throw new Error("Owner project child fence changed");
        }
        const recipients = await trx.selectFrom("collaboration_members").select("actor_id")
          .where("scope_id", "=", project.id)
          .where("status", "=", "accepted")
          .execute();
        await appendMutationRecords(trx, {
          scope: updated,
          actorId: input.actorId,
          action: "scope.owner_membership_ended",
          now: committedAt,
          recipients: recipients.map((recipient) => ({ actorId: recipient.actor_id })),
          discoveryState: "revoked",
          reasonCode: "owner_membership_ended",
        });
        const operationId = randomUUID();
        const scopeIds = [project.id, ...ownedChildren.map((child) => child.id)];
        await trx.insertInto("collaboration_operations").values({
          scope_id: project.id,
          actor_id: input.actorId,
          client_request_id: operationId,
          operation_kind: OWNER_DEPARTURE_OPERATION,
          payload_hash: createHash("sha256")
            .update(`${input.organizationId}\0${input.actorId}\0${project.id}\0${updated.revision}`)
            .digest("hex"),
          status: "accepted",
          result_ref: jsonb({ scopeIds, revision: Number(updated.revision) }),
          expected_revision: Number(updated.revision),
          accepted_auth_epoch: Number(updated.auth_epoch),
          created_at: committedAt,
          expires_at: new Date(new Date(committedAt).getTime() + OPERATION_RETENTION_MS),
        }).execute();
        ownerCleanups.push({
          projectScopeId: project.id,
          operationId,
          scopeIds,
          revision: Number(updated.revision),
        });
      }
      return { projects, children, ownerCleanups };
    });
    this.options.sessions.revoke(input);
    const childrenByProject = new Map<string, string[]>();
    for (const child of children) {
      if (!child.parent_scope_id) continue;
      const grouped = childrenByProject.get(child.parent_scope_id) ?? [];
      grouped.push(child.id);
      childrenByProject.set(child.parent_scope_id, grouped);
    }
    for (const project of projects) {
      if (project.owner_id === input.actorId) continue;
      const scopes = [project.id, ...(childrenByProject.get(project.id) ?? [])];
      for (const scopeId of scopes) await this.options.drainScope(scopeId, input.actorId);
    }
    for (const cleanup of ownerCleanups) {
      await completeAcceptedOperation(this.options.db, {
        scopeId: cleanup.projectScopeId,
        actorId: input.actorId,
        clientRequestId: cleanup.operationId,
        operationKind: OWNER_DEPARTURE_OPERATION,
      }, async (trx) => {
        const fence = await trx.selectFrom("collaboration_scopes")
          .select("id")
          .where("id", "=", cleanup.projectScopeId)
          .where("lifecycle", "=", "private")
          .where("revision", "=", cleanup.revision)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (!fence) throw new Error("Owner project departure fence is unavailable");
        this.options.sessions.revoke({ scopeId: cleanup.projectScopeId });
        for (const scopeId of cleanup.scopeIds) await this.options.drainScope(scopeId);
      });
    }
  }

  async unshared(
    input: { scopeId: string; revision: number },
    executor: CollaborationExecutor = this.options.db,
  ): Promise<void> {
    const project = await executor.selectFrom("collaboration_scopes")
      .select("id")
      .where("id", "=", input.scopeId)
      .where("kind", "=", "project")
      .where("lifecycle", "=", "private")
      .where("revision", "=", input.revision)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!project) throw new Error("Project revocation fence is unavailable");
    const children = await this.childrenFor([project.id], executor);
    this.options.sessions.revoke({ scopeId: project.id });
    for (const scopeId of [project.id, ...children.map((child) => child.id)]) {
      await this.options.drainScope(scopeId);
    }
  }

  private async childrenFor(
    projectScopeIds: readonly string[],
    executor: CollaborationExecutor = this.options.db,
  ) {
    if (projectScopeIds.length === 0) return [];
    const children = await executor.selectFrom("collaboration_scopes")
      .select(["id", "parent_scope_id"])
      .where("parent_scope_id", "in", projectScopeIds)
      .where("membership_mode", "=", "inherited")
      .where("deleted_at", "is", null)
      .orderBy("id")
      .limit(MAX_PROJECT_SCOPES + 1)
      .execute();
    if (children.length > MAX_PROJECT_SCOPES) {
      throw new Error("Project scope revocation capacity exceeded");
    }
    return children;
  }
}

function keyFor(scopeId: string, actorId: string): string {
  return `${scopeId}\0${actorId}`;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Invalid ${label}`);
  }
  return value;
}
