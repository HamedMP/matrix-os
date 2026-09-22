/**
 * S09 / T045, T048: immutable run-loss and run-control records.
 *
 * `collaboration_run_interruptions` records exactly one loss reason per
 * canonical run the home lost (gateway restart, scope-runtime crash, run unit
 * exit without a terminal result, control partition past its lease) with the
 * requesting member attributed; the first recorded reason wins. The status
 * itself still lives on the canonical run and its queued request: this table
 * only explains an `interrupted` state and never revives a run.
 *
 * `collaboration_run_decisions` is the audit of who cancelled a run, who
 * answered a tool approval and who retried a request, with the relation the
 * locked run-control rule authorized (`requester` or `scope_owner`). Rows are
 * written inside the same transaction as the command that authorized them.
 */
import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import {
  CollaborationRunInterruptionReasonSchema,
  type CollaborationRunInterruptionReason,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { ChatOwner } from "../chat/records.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import { toIso } from "./repository-shared.js";
import { ScopeRuntimeClientError } from "./scope-runtime-client.js";

export const COLLABORATION_SHARED_RUN_LOSS_MIGRATION_VERSION = 11;

export async function migrateSharedRunLossV11(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_run_interruptions (
      run_id TEXT PRIMARY KEY CHECK (char_length(run_id) BETWEEN 1 AND 160),
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 160),
      request_id TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 160),
      requesting_actor_id TEXT NOT NULL CHECK (char_length(requesting_actor_id) BETWEEN 1 AND 128),
      reason TEXT NOT NULL CHECK (reason IN ('gateway_restart', 'scope_runtime_crash', 'run_unit_exit', 'control_partition')),
      recorded_at TIMESTAMPTZ NOT NULL
    )
  `.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_run_decisions (
      id UUID PRIMARY KEY,
      run_id TEXT CHECK (run_id IS NULL OR char_length(run_id) BETWEEN 1 AND 160),
      request_id TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 160),
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('cancel', 'tool_approval', 'retry')),
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      relation TEXT NOT NULL CHECK (relation IN ('requester', 'scope_owner')),
      approval_id TEXT CHECK (approval_id IS NULL OR char_length(approval_id) BETWEEN 1 AND 160),
      decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'approve_for_session', 'decline', 'cancel')),
      decided_at TIMESTAMPTZ NOT NULL
    )
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_run_decisions_run
    ON collaboration_run_decisions(run_id, decided_at)
  `.execute(trx);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (${COLLABORATION_SHARED_RUN_LOSS_MIGRATION_VERSION})
    ON CONFLICT (version) DO NOTHING
  `.execute(trx);
}

const InterruptionInputSchema = z.object({
  runId: z.string().min(1).max(160),
  scopeId: z.string().uuid(),
  chatId: z.string().min(1).max(160),
  requestId: z.string().min(1).max(160),
  requestingActorId: z.string().min(1).max(128),
  reason: CollaborationRunInterruptionReasonSchema,
}).strict();

const DecisionInputSchema = z.object({
  /** Absent for a request that was cancelled before any run claimed it. */
  runId: z.string().min(1).max(160).nullable(),
  requestId: z.string().min(1).max(160),
  scopeId: z.string().uuid(),
  kind: z.enum(["cancel", "tool_approval", "retry"]),
  actorId: z.string().min(1).max(128),
  relation: z.enum(["requester", "scope_owner"]),
  approvalId: z.string().min(1).max(160).optional(),
  decision: z.enum(["approve", "approve_for_session", "decline", "cancel"]).optional(),
}).strict();

export type CollaborationRunControlRelation = "requester" | "scope_owner";
export type CollaborationRunInterruptionInput = z.infer<typeof InterruptionInputSchema>;
export type CollaborationRunDecisionInput = z.infer<typeof DecisionInputSchema>;

export interface CollaborationRunInterruption extends CollaborationRunInterruptionInput {
  recordedAt: string;
}

export interface CollaborationRunDecision extends CollaborationRunDecisionInput {
  id: string;
  decidedAt: string;
}

type Executor = Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>;

const MAX_LISTED_DECISIONS = 100;
const MAX_INTERRUPTION_LOOKUP = 100;

export class CollaborationRunLossRepository {
  private readonly now: () => Date;

  constructor(private readonly db: Kysely<OwnerCollaborationDatabase>, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Idempotent: the first recorded reason for a run wins. */
  async recordInterruption(rawInput: CollaborationRunInterruptionInput, executor: Executor = this.db): Promise<void> {
    const input = InterruptionInputSchema.parse(rawInput);
    await executor.insertInto("collaboration_run_interruptions").values({
      run_id: input.runId,
      scope_id: input.scopeId,
      chat_id: input.chatId,
      request_id: input.requestId,
      requesting_actor_id: input.requestingActorId,
      reason: input.reason,
      recorded_at: this.now().toISOString(),
    }).onConflict((conflict) => conflict.column("run_id").doNothing()).execute();
  }

  async getInterruption(runId: string): Promise<CollaborationRunInterruption | null> {
    const row = await this.db.selectFrom("collaboration_run_interruptions").selectAll()
      .where("run_id", "=", z.string().min(1).max(160).parse(runId)).executeTakeFirst();
    return row ? toInterruption(row) : null;
  }

  /** Bounded lookup for projecting a request list; unknown runs are simply absent. */
  async interruptionsFor(runIds: readonly string[]): Promise<Map<string, CollaborationRunInterruption>> {
    const ids = [...new Set(runIds)].slice(0, MAX_INTERRUPTION_LOOKUP);
    if (ids.length === 0) return new Map();
    const rows = await this.db.selectFrom("collaboration_run_interruptions").selectAll()
      .where("run_id", "in", ids).execute();
    return new Map(rows.map((row) => [row.run_id, toInterruption(row)]));
  }

  async recordDecision(rawInput: CollaborationRunDecisionInput, executor: Executor = this.db): Promise<CollaborationRunDecision> {
    const input = DecisionInputSchema.parse(rawInput);
    const id = randomUUID();
    const decidedAt = this.now().toISOString();
    await executor.insertInto("collaboration_run_decisions").values({
      id,
      run_id: input.runId,
      request_id: input.requestId,
      scope_id: input.scopeId,
      kind: input.kind,
      actor_id: input.actorId,
      relation: input.relation,
      approval_id: input.approvalId ?? null,
      decision: input.decision ?? null,
      decided_at: decidedAt,
    }).execute();
    return { ...input, id, decidedAt };
  }

  async listDecisions(runOrRequestId: string): Promise<CollaborationRunDecision[]> {
    const id = z.string().min(1).max(160).parse(runOrRequestId);
    const rows = await this.db.selectFrom("collaboration_run_decisions").selectAll()
      .where((eb) => eb.or([eb("run_id", "=", id), eb("request_id", "=", id)]))
      .orderBy("decided_at").orderBy("id").limit(MAX_LISTED_DECISIONS).execute();
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      requestId: row.request_id,
      scopeId: row.scope_id,
      kind: row.kind,
      actorId: row.actor_id,
      relation: row.relation as CollaborationRunControlRelation,
      ...(row.approval_id ? { approvalId: row.approval_id } : {}),
      ...(row.decision ? { decision: row.decision } : {}),
      decidedAt: toIso(row.decided_at),
    }));
  }

  /**
   * Latest cancel decision per request for list projections. A request can own
   * more than one cancel row when an external cancellation failed and was
   * retried, so the latest row is selected per request in SQL: a batch-wide
   * history cap would drop the newest decisions and project a stale or absent
   * `decidedBy`. The result is bounded by the number of requests asked for.
   */
  async decisionsFor(requestIds: readonly string[]): Promise<Map<string, CollaborationRunDecision>> {
    const ids = [...new Set(requestIds)].slice(0, MAX_INTERRUPTION_LOOKUP);
    if (ids.length === 0) return new Map();
    const rows = await this.db.selectFrom("collaboration_run_decisions").distinctOn("request_id").selectAll()
      .where("request_id", "in", ids).where("kind", "=", "cancel")
      .orderBy("request_id").orderBy("decided_at", "desc").orderBy("id", "desc")
      .limit(ids.length).execute();
    const latest = new Map<string, CollaborationRunDecision>();
    for (const row of rows) {
      latest.set(row.request_id, {
        id: row.id, runId: row.run_id, requestId: row.request_id, scopeId: row.scope_id, kind: row.kind,
        actorId: row.actor_id, relation: row.relation as CollaborationRunControlRelation, decidedAt: toIso(row.decided_at),
      });
    }
    return latest;
  }
}

function toInterruption(row: {
  run_id: string; scope_id: string; chat_id: string; request_id: string;
  requesting_actor_id: string; reason: string; recorded_at: Date | string;
}): CollaborationRunInterruption {
  return {
    runId: row.run_id,
    scopeId: row.scope_id,
    chatId: row.chat_id,
    requestId: row.request_id,
    requestingActorId: row.requesting_actor_id,
    reason: CollaborationRunInterruptionReasonSchema.parse(row.reason),
    recordedAt: toIso(row.recorded_at),
  };
}

export type SharedRunLossStage = "create" | "state" | "inference" | "projection";

/**
 * Classifies an isolated-run failure into a frozen loss reason. Supervisor and
 * runtime unavailability are a scope-runtime crash; a unit that stops
 * answering mid-inference is a run unit exit. Projection failures happen after
 * the unit produced its result and are ordinary run failures, not losses.
 */
export function classifySharedRunLoss(error: unknown, stage: SharedRunLossStage): CollaborationRunInterruptionReason | null {
  if (stage === "projection") return null;
  if (error instanceof ScopeRuntimeClientError) {
    return error.code === "runtime_unavailable" || error.code === "client_closed" ? "scope_runtime_crash" : null;
  }
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "runtime_exited" || code === "runtime_lost") return "run_unit_exit";
  if (stage === "create" || stage === "state") return "scope_runtime_crash";
  return "run_unit_exit";
}

const LOST_RUN_BATCH = 64;
const MAX_LOST_RUN_BATCHES = 64;
const ACTIVE_RUN_STATUSES = ["accepted", "running", "waiting_for_approval", "waiting_for_input"] as const;

async function listActiveSharedRuns(
  db: Kysely<OwnerCollaborationDatabase>,
  limit = LOST_RUN_BATCH,
  options: { unmarkedOnly?: boolean } = {},
): Promise<Array<{
  runId: string; scopeId: string; chatId: string; requestId: string; requestingActorId: string; ownerId: string;
}>> {
  const rows = await db.selectFrom("chat_queued_turns as queued")
    .innerJoin("chat_runs as run", "run.id", "queued.claimed_run_id")
    .innerJoin("collaboration_scopes as scope", "scope.id", "queued.collaboration_scope_id")
    .$if(options.unmarkedOnly === true, (query) => query
      .leftJoin("collaboration_run_interruptions as interruption", "interruption.run_id", "run.id")
      .where("interruption.run_id", "is", null))
    .select([
      "run.id as run_id", "queued.id as request_id", "queued.chat_id as chat_id",
      "queued.requesting_actor_id as requesting_actor_id", "scope.id as scope_id", "scope.owner_id as owner_id",
    ])
    .where("queued.status", "=", "claimed")
    .where("run.status", "in", [...ACTIVE_RUN_STATUSES])
    .where("scope.kind", "=", "chat")
    .orderBy("queued.created_at")
    .limit(limit)
    .execute();
  return rows.flatMap((row) => row.requesting_actor_id ? [{
    runId: row.run_id, scopeId: row.scope_id, chatId: row.chat_id, requestId: row.request_id,
    requestingActorId: row.requesting_actor_id, ownerId: row.owner_id,
  }] : []);
}

/**
 * At gateway start every shared run that is still active in the database was
 * lost with the previous process. Record `gateway_restart` before the
 * orchestrator's recovery finishes the run; a second start finds nothing new.
 * Runs are read in bounded batches until none is left unmarked, so a home
 * with more lost runs than one batch still attributes every one of them.
 */
export async function markLostSharedRunsOnStartup(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  loss: Pick<CollaborationRunLossRepository, "recordInterruption" | "getInterruption">;
  batchSize?: number;
}): Promise<string[]> {
  const batchSize = Math.min(Math.max(options.batchSize ?? LOST_RUN_BATCH, 1), LOST_RUN_BATCH);
  const marked: string[] = [];
  for (let batch = 0; batch < MAX_LOST_RUN_BATCHES; batch += 1) {
    // Each batch reads only runs without a recorded loss, so marking pages forward on its own.
    const unmarked = await listActiveSharedRuns(options.db, batchSize, { unmarkedOnly: true });
    if (unmarked.length === 0) break;
    for (const run of unmarked) {
      await options.loss.recordInterruption({ ...omitOwner(run), reason: "gateway_restart" });
      marked.push(run.runId);
    }
    if (unmarked.length < batchSize) break;
  }
  return marked;
}

/**
 * The home lost its control authority (or its scope runtime): every active
 * shared run is recorded as lost with the given reason and stopped through the
 * orchestrator so the queued request settles as interrupted, never as a silent
 * cancel. Queued requests are untouched; they re-admit on fresh membership.
 */
export async function interruptActiveSharedRuns(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  loss: Pick<CollaborationRunLossRepository, "recordInterruption">;
  reason: CollaborationRunInterruptionReason;
  orchestrator: {
    cancelSharedRun(
      owner: ChatOwner, scopeId: string, chatId: string, runId: string,
      options?: { sharedRequestState?: "cancelled" | "interrupted" },
    ): Promise<void>;
  };
  scopeId?: string;
}): Promise<string[]> {
  const interrupted: string[] = [];
  for (const run of await listActiveSharedRuns(options.db)) {
    if (options.scopeId && run.scopeId !== options.scopeId) continue;
    await options.loss.recordInterruption({ ...omitOwner(run), reason: options.reason });
    try {
      // The queued request settles as `interrupted`, never as a member cancel, so the requester may retry it.
      await options.orchestrator.cancelSharedRun(
        { type: "personal", ownerId: run.ownerId }, run.scopeId, run.chatId, run.runId, { sharedRequestState: "interrupted" },
      );
    } catch (error: unknown) {
      console.warn("[collaboration] lost shared run stop deferred to recovery",
        error instanceof Error ? error.name : "UnknownError");
    }
    interrupted.push(run.runId);
  }
  return interrupted;
}

function omitOwner(run: { runId: string; scopeId: string; chatId: string; requestId: string; requestingActorId: string }) {
  return { runId: run.runId, scopeId: run.scopeId, chatId: run.chatId, requestId: run.requestId, requestingActorId: run.requestingActorId };
}

/**
 * Drives control-partition interruption from the S05 control snapshot: when
 * freshness lapses past the lease the callback fires once per outage episode,
 * and a restored control stream re-arms it. Never extends authority.
 * `check()` runs one tick on demand and settles its interruption, for callers
 * that own their own timers (and tests); `stop()` ends the periodic tick.
 */
export function startControlLossWatchdog(options: {
  controlFresh(): boolean;
  onLost(): Promise<unknown>;
  intervalMs?: number;
  startTimer?: boolean;
}): { stop(): void; check(): Promise<void> } {
  const intervalMs = Math.min(Math.max(options.intervalMs ?? 5_000, 250), 60_000);
  let lost = false;
  let inFlight: Promise<unknown> | undefined;
  const tick = (): Promise<unknown> | undefined => {
    const fresh = options.controlFresh();
    if (fresh) { lost = false; return undefined; }
    if (lost || inFlight) return inFlight;
    lost = true;
    inFlight = options.onLost().catch((error: unknown) => {
      console.warn("[collaboration] control loss interruption failed",
        error instanceof Error ? error.name : "UnknownError");
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const timer = options.startTimer === false ? undefined : setInterval(() => { void tick(); }, intervalMs);
  timer?.unref?.();
  return {
    stop: () => { if (timer) clearInterval(timer); },
    check: async () => { await tick(); },
  };
}
