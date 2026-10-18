import { sql, type Kysely } from "kysely";
import { ensureWorkspace, type WorkspaceDatabase, WorkspaceError } from "./repository.js";
import type { RuntimeCheckpoint, RuntimeJob, RuntimeLease, RuntimeStore, RuntimeSummary } from "../runtime/contracts.js";

import type { RuntimeComputeHooks } from "../runtime/compute-hooks.js";

const MAX_ACTIVE_RUNS = 1;
export class RuntimeBusyError extends Error { constructor() { super("Runtime busy"); this.name = "RuntimeBusyError"; } }
const toLease = (row: WorkspaceDatabase["shared_runtime_jobs"]): RuntimeLease => ({ ownerId: row.owner_id, jobId: row.job_id, generation: row.generation, expiresAt: row.expires_at, maxRunAt: row.max_run_at });
/** All state transitions serialize on an owner row. Jobs are never rerun after admission. */
export class PostgresRuntimeStore implements RuntimeStore {
  constructor(readonly db: Kysely<WorkspaceDatabase>, private readonly compute?: RuntimeComputeHooks) {}
  async initialize() {
    await this.db.schema.createTable("shared_runtime_jobs").ifNotExists()
      .addColumn("owner_id", "text", (c) => c.notNull()).addColumn("job_id", "text", (c) => c.notNull())
      .addColumn("generation", "integer", (c) => c.notNull()).addColumn("state", "text", (c) => c.notNull())
      .addColumn("expires_at", "double precision", (c) => c.notNull()).addColumn("max_run_at", "double precision", (c) => c.notNull())
      .addColumn("payload", "jsonb", (c) => c.notNull()).addPrimaryKeyConstraint("shared_jobs_owner_id", ["owner_id", "job_id"]).execute();
    await this.db.schema.createIndex("shared_jobs_active").ifNotExists().on("shared_runtime_jobs").columns(["owner_id", "state"]).execute();
    await this.db.schema.createTable("shared_runtime_bindings").ifNotExists()
      .addColumn("runtime_id", "text", (c) => c.primaryKey()).addColumn("owner_id", "text", (c) => c.notNull()).execute();
  }
  async bindRuntime(runtimeId: string, ownerId: string) {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto("shared_runtime_bindings").values({ runtime_id: runtimeId, owner_id: ownerId }).onConflict((oc) => oc.column("runtime_id").doNothing()).execute();
      const row = await trx.selectFrom("shared_runtime_bindings").select("owner_id").where("runtime_id", "=", runtimeId).executeTakeFirstOrThrow();
      if (row.owner_id !== ownerId) throw new WorkspaceError("conflict");
    });
  }
  async ownerForRuntime(runtimeId: string) {
    return (await this.db.selectFrom("shared_runtime_bindings").select("owner_id").where("runtime_id", "=", runtimeId).executeTakeFirst())?.owner_id ?? null;
  }
  async status(ownerId: string): Promise<RuntimeSummary> {
    const row = await this.db.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", ownerId).executeTakeFirst();
    const activeRuns = (await this.active(ownerId, Date.now())).length;
    return { state: (row?.runtime_state ?? "sleeping") as RuntimeSummary["state"], placement: (row?.placement ?? "pooled") as RuntimeSummary["placement"], activeRuns, generation: row?.generation ?? 1, idleSince: row?.idle_since ?? null };
  }
  async claim(job: RuntimeJob, now: number, leaseMs: number, maxRunMs: number): Promise<RuntimeLease | null> {
    return this.db.transaction().execute(async (trx) => {
      await ensureWorkspace(trx, job.ownerId);
      const row = await trx.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", job.ownerId).forUpdate().executeTakeFirstOrThrow();
      if (row.placement !== "pooled") return null;
      if (["checkpointing", "interrupting"].includes(row.runtime_state)) throw new RuntimeBusyError();
      const duplicate = await trx.selectFrom("shared_runtime_jobs").select("job_id").where("owner_id", "=", job.ownerId).where("job_id", "=", job.jobId).executeTakeFirst();
      if (duplicate) return null;
      const active = await trx.selectFrom("shared_runtime_jobs").select("job_id").where("owner_id", "=", job.ownerId).where("state", "=", "running").limit(MAX_ACTIVE_RUNS).execute();
      if (active.length >= MAX_ACTIVE_RUNS) throw new RuntimeBusyError();
      if (this.compute && !await this.compute.claim(trx, job, now, maxRunMs, row.generation)) return null;
      const lease = { ownerId: job.ownerId, jobId: job.jobId, generation: row.generation, expiresAt: now + Math.min(leaseMs, maxRunMs), maxRunAt: now + maxRunMs };
      const inserted = await trx.insertInto("shared_runtime_jobs").values({ owner_id: job.ownerId, job_id: job.jobId, generation: row.generation, state: "running", expires_at: lease.expiresAt, max_run_at: lease.maxRunAt, payload: { ...job } })
        .onConflict((oc) => oc.columns(["owner_id", "job_id"]).doNothing()).returning("job_id").executeTakeFirst();
      if (!inserted) return null;
      await trx.updateTable("shared_workspaces").set({ runtime_state: "running", idle_since: null }).where("owner_id", "=", job.ownerId).execute();
      return lease;
    });
  }
  async heartbeat(lease: RuntimeLease, now: number, leaseMs: number): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", lease.ownerId).forUpdate().executeTakeFirst();
      if (!row || row.generation !== lease.generation || row.placement !== "pooled" || row.runtime_state === "checkpointing") return false;
      if (this.compute && (!await this.compute.allowed(trx, lease.ownerId) || await this.compute.needsInterruption?.(trx,lease.ownerId,lease.generation))) return false;
      const updated = await trx.updateTable("shared_runtime_jobs").set({ expires_at: sql`least(${now + leaseMs}, max_run_at)` })
        .where("owner_id", "=", lease.ownerId).where("job_id", "=", lease.jobId).where("generation", "=", lease.generation)
        .where("state", "=", "running").where("expires_at", ">", now).where("max_run_at", ">", now).returning("job_id").executeTakeFirst();
      return !!updated;
    });
  }
  async finish(lease: RuntimeLease, outcome: "completed" | "interrupted", now: number): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", lease.ownerId).forUpdate().executeTakeFirst();
      if (!row || row.generation !== lease.generation || row.placement !== "pooled") return false;
      let query = trx.updateTable("shared_runtime_jobs").set({ state: outcome }).where("owner_id", "=", lease.ownerId)
        .where("job_id", "=", lease.jobId).where("generation", "=", lease.generation).where("state", "=", "running");
      if (outcome === "completed") query = query.where("expires_at", ">", now).where("max_run_at", ">", now);
      const updated = await query.returning("job_id").executeTakeFirst();
      if (!updated) return false;
      if (outcome === "completed") await this.compute?.completion(trx, lease, now);
      else await this.compute?.uncertain(trx, lease.ownerId, lease.generation);
      const active = await trx.selectFrom("shared_runtime_jobs").select("job_id").where("owner_id", "=", lease.ownerId).where("state", "=", "running").limit(1).executeTakeFirst();
      if (!active) await trx.updateTable("shared_workspaces").set({ runtime_state: "ready", idle_since: now }).where("owner_id", "=", lease.ownerId).execute();
      return true;
    });
  }
  async active(ownerId: string, _now: number): Promise<RuntimeLease[]> {
    return (await this.db.selectFrom("shared_runtime_jobs").selectAll().where("owner_id", "=", ownerId).where("state", "=", "running").limit(MAX_ACTIVE_RUNS).execute()).map(toLease);
  }
  /** Fence the whole compute generation before destroy; claims stay blocked until confirmed stop. */
  async beginInterrupt(lease: RuntimeLease, now: number): Promise<number | null> {
    return this.db.transaction().execute(async (trx) => {
      const workspace = await trx.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", lease.ownerId).forUpdate().executeTakeFirst();
      if (!workspace || workspace.placement !== "pooled" || workspace.generation !== lease.generation) return null;
      const job = await trx.selectFrom("shared_runtime_jobs").select("job_id").where("owner_id", "=", lease.ownerId).where("job_id", "=", lease.jobId)
        .where("generation", "=", lease.generation).where("state", "=", "running").executeTakeFirst();
      if (!job) return null;
      await this.compute?.uncertain(trx, lease.ownerId, lease.generation);
      const generation = workspace.generation + 1;
      await trx.updateTable("shared_runtime_jobs").set({ state: "interrupted" }).where("owner_id", "=", lease.ownerId).where("generation", "=", lease.generation).where("state", "=", "running").execute();
      await trx.updateTable("shared_workspaces").set({ generation, runtime_state: "interrupting", idle_since: now }).where("owner_id", "=", lease.ownerId).execute();
      return generation;
    });
  }
  /** Bound idle checkpoint retries without touching active or personal machines. */
  async beginIdleInterrupt(ownerId: string, generation: number, now: number): Promise<number | null> {
    return this.db.transaction().execute(async (trx) => {
      const workspace = await trx.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", ownerId).forUpdate().executeTakeFirst();
      if (!workspace || workspace.placement !== "pooled" || workspace.generation !== generation
        || !["failed", "checkpointing", "ready"].includes(workspace.runtime_state) || workspace.idle_since === null) return null;
      const active = await trx.selectFrom("shared_runtime_jobs").select("job_id").where("owner_id", "=", ownerId).where("state", "=", "running").limit(1).executeTakeFirst();
      if (active) return null;
      const nextGeneration = generation + 1;
      await trx.updateTable("shared_workspaces").set({ generation: nextGeneration, runtime_state: "interrupting", idle_since: now })
        .where("owner_id", "=", ownerId).execute();
      return nextGeneration;
    });
  }
  async recoverExpired(ownerId: string, now: number) {
    await this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", ownerId).forUpdate().executeTakeFirst();
      if (!row || row.placement !== "pooled") return;
      const interrupted = await trx.updateTable("shared_runtime_jobs").set({ state: "interrupted" }).where("owner_id", "=", ownerId).where("state", "=", "running")
        .where((eb) => eb.or([eb("expires_at", "<=", now), eb("max_run_at", "<=", now)])).returning("job_id").execute();
      if (!interrupted.length) return;
      await this.compute?.uncertain(trx, ownerId, row.generation);
      const active = await trx.selectFrom("shared_runtime_jobs").select("job_id").where("owner_id", "=", ownerId).where("state", "=", "running").limit(1).executeTakeFirst();
      if (!active) {
        // Budgeted recovery must quarantine before any termination-based settlement.
        await trx.updateTable("shared_workspaces").set(this.compute
          ? {runtime_state:"interrupting",generation:row.generation+1,idle_since:now}
          : {runtime_state:"ready",idle_since:now}).where("owner_id","=",ownerId).execute();
      }
    });
  }
  /** Idempotent re-entry recovers a DO eviction after the transition committed. */
  async beginCheckpoint(ownerId: string, now: number, idleGraceMs: number): Promise<number | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", ownerId).forUpdate().executeTakeFirst();
      if (!row || row.placement !== "pooled" || !["ready", "failed", "checkpointing"].includes(row.runtime_state) || row.idle_since === null || now - row.idle_since < idleGraceMs) return null;
      const active = await trx.selectFrom("shared_runtime_jobs").select("job_id").where("owner_id", "=", ownerId).where("state", "=", "running").limit(1).executeTakeFirst();
      if (active) return null;
      await trx.updateTable("shared_workspaces").set({ runtime_state: "checkpointing" }).where("owner_id", "=", ownerId).execute();
      return row.generation;
    });
  }
  async saveCheckpoint(ownerId: string, checkpoint: RuntimeCheckpoint): Promise<boolean> {
    const updated = await this.db.updateTable("shared_workspaces").set({ checkpoint: { ...checkpoint } }).where("owner_id", "=", ownerId)
      .where("generation", "=", checkpoint.generation).where("runtime_state", "in", ["running", "ready", "checkpointing"]).where("placement", "=", "pooled").returning("owner_id").executeTakeFirst();
    return !!updated;
  }
  async latestCheckpoint(ownerId: string): Promise<RuntimeCheckpoint | null> {
    const row = await this.db.selectFrom("shared_workspaces").select("checkpoint").where("owner_id", "=", ownerId).executeTakeFirst();
    return row?.checkpoint as RuntimeCheckpoint | null ?? null;
  }
  async markSleeping(ownerId: string, generation: number): Promise<boolean> {
    const updated = await this.db.updateTable("shared_workspaces").set({ runtime_state: "sleeping", generation: sql`generation + 1`, idle_since: null })
      .where("owner_id", "=", ownerId).where("generation", "=", generation).where("placement", "=", "pooled").where("runtime_state", "=", "checkpointing")
      .where(sql<boolean>`checkpoint->>'generation' = ${String(generation)}`).returning("owner_id").executeTakeFirst();
    return !!updated;
  }
  async confirmStopped(ownerId: string, generation: number, now: number): Promise<boolean> {
    return this.db.transaction().execute(async trx => {
      const row = await trx.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", ownerId).forUpdate().executeTakeFirst();
      if (!row || row.placement !== "pooled" || row.generation !== generation || row.runtime_state !== "interrupting") return false;
      await this.compute?.confirmStopped(trx, ownerId, generation, now);
      await trx.updateTable("shared_workspaces").set({runtime_state:"failed",idle_since:null}).where("owner_id","=",ownerId).where("generation","=",generation).execute();
      return true;
    });
  }
  async fail(ownerId: string, generation: number) {
    await this.db.updateTable("shared_workspaces").set({ runtime_state: "failed" }).where("owner_id", "=", ownerId).where("generation", "=", generation).where("placement", "=", "pooled").execute();
  }
}
