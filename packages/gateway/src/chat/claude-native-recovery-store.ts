import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CanonicalChatActionDigestSchema, CanonicalChatIdSchema, CanonicalChatRunIdSchema, ProtectedToolOutputSchema,
  canonicalExecutionRootProjectId,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod/v4";
import { openToolOutput, sealToolOutput } from "../coding-agents/protected-tool-output.mjs";
import { ClaudeNativeScheduleReplaySchema } from "./claude-native-replay-receipt.js";
import type { ChatDatabase, ChatsTable, ClaudeNativeRecoveryTable } from "./database.js";
import { asIso, jsonb, parseJson, toRun } from "./records.js";

const maxSessionMs = 7 * 24 * 60 * 60 * 1000;
const maxGeneration = 2_147_483_647;
const maxRecoverableSessions = 32;
// Leave room for the spaces PostgreSQL inserts into the JSONB text checked by the table constraint.
const maxEncodedJobsBytes = 30_000;
const ownerIdSchema = z.string().min(1).max(160);
const jobIdSchema = z.string().regex(/^[0-9a-f]{8}$/);
const nativeUuidSchema = z.uuid().transform(value => value.toLowerCase());
const jobMetadataSchema = z.object({
  id: jobIdSchema,
  assistantUuid: nativeUuidSchema,
  receiptUuid: nativeUuidSchema,
  cron: z.string().min(1).max(256).regex(/^[!-~]+( +[!-~]+){4}$/),
  promptSha256: CanonicalChatActionDigestSchema,
  recurring: z.boolean(),
}).strict();
const jobSchema = jobMetadataSchema.extend({ replay: ClaudeNativeScheduleReplaySchema.optional() });
const storedJobSchema = jobMetadataSchema.extend({ replayEnvelope: ProtectedToolOutputSchema.optional() });
const storedJobsSchema = z.array(storedJobSchema).max(50);
const jobsSchema = z.array(jobSchema).max(50).refine(jobs =>
  new Set(jobs.map(job => job.id)).size === jobs.length
    && new Set(jobs.map(job => job.promptSha256)).size === jobs.length,
);
const inputSchema = z.object({
  ownerId: ownerIdSchema,
  chatId: CanonicalChatIdSchema,
  sessionId: nativeUuidSchema,
  sourceRunId: CanonicalChatRunIdSchema,
  sourceFingerprint: CanonicalChatActionDigestSchema,
  deadlineAt: z.iso.datetime().transform(value => new Date(value).toISOString()),
  jobs: jobsSchema,
}).strict();
const receiptSchema = inputSchema.extend({
  generation: z.number().int().min(1).max(maxGeneration),
  status: z.enum(["active", "released", "invalid"]),
}).refine(receipt => (receipt.status === "invalid") === (receipt.jobs.length === 0));
const sessionStateSchema = z.object({ sessionId: nativeUuidSchema });

export type ClaudeNativeRecoveryJob = z.infer<typeof jobSchema>;
export type ClaudeNativeRecoveryInput = z.infer<typeof inputSchema>;
export type ClaudeNativeRecoveryReceipt = z.infer<typeof receiptSchema>;
const admissionFenceSchema = inputSchema.pick({
  ownerId: true, chatId: true, sessionId: true, sourceRunId: true, sourceFingerprint: true,
}).extend({
  generation: z.number().int().min(1).max(maxGeneration),
  jobId: jobIdSchema,
  promptSha256: CanonicalChatActionDigestSchema,
}).strict();
export type ClaudeNativeRecoveryAdmissionFence = z.infer<typeof admissionFenceSchema>;

type StoredRecoveryJob = z.infer<typeof storedJobSchema>;
type RecoveryJobScope = Pick<ClaudeNativeRecoveryInput, "ownerId" | "chatId" | "sessionId" | "sourceFingerprint" | "deadlineAt">;

function replayBinding(scope: RecoveryJobScope, job: z.infer<typeof jobMetadataSchema>) {
  return JSON.stringify(["claude-native-recovery", scope.ownerId, scope.chatId, scope.sessionId,
    scope.sourceFingerprint, scope.deadlineAt, job.id, job.cron, job.promptSha256,
    job.assistantUuid, job.receiptUuid, job.recurring]);
}

function validReplay(job: ClaudeNativeRecoveryJob, deadlineAt: string) {
  return job.replay && job.recurring && job.replay.receivedAtMs <= Date.parse(deadlineAt)
    && createHash("sha256").update(job.replay.prompt).digest("hex") === job.promptSha256;
}

function encodeJobs(input: ClaudeNativeRecoveryInput, key?: Buffer): StoredRecoveryJob[] | null {
  const encoded: StoredRecoveryJob[] = [];
  for (const { replay, ...job } of input.jobs) {
    if (!replay) { encoded.push(job); continue; }
    const payload = JSON.stringify(replay);
    if (key?.length !== 32 || !validReplay({ ...job, replay }, input.deadlineAt)) return null;
    if (payload.length > 4000 || Buffer.byteLength(payload) > 16_384) {
      console.warn("[claude-native] Recovery skipped: replay job size limit");
      return null;
    }
    encoded.push({ ...job, replayEnvelope: sealToolOutput(key, replayBinding(input, job), payload) });
  }
  if (Buffer.byteLength(JSON.stringify(encoded)) > maxEncodedJobsBytes) {
    console.warn("[claude-native] Recovery skipped: replay receipt size limit");
    return null;
  }
  return encoded;
}

function toReceipt(row: Selectable<ClaudeNativeRecoveryTable>, key?: Buffer): ClaudeNativeRecoveryReceipt | null {
  const deadlineAt = asIso(row.deadline_at);
  if (!deadlineAt) return null;
  const scope = { ownerId: row.owner_id, chatId: row.chat_id, sessionId: row.session_id,
    sourceFingerprint: row.source_fingerprint, deadlineAt };
  try {
    const stored = storedJobsSchema.parse(parseJson(row.jobs));
    const jobs: ClaudeNativeRecoveryJob[] = [];
    for (const { replayEnvelope, ...job } of stored) {
      if (!replayEnvelope) { jobs.push(job); continue; }
      if (key?.length !== 32) return null;
      const replay = ClaudeNativeScheduleReplaySchema.parse(JSON.parse(openToolOutput(key, replayBinding(scope, job), replayEnvelope)));
      if (!validReplay({ ...job, replay }, scope.deadlineAt)) return null;
      jobs.push({ ...job, replay });
    }
    return receiptSchema.parse({ ...scope, sourceRunId: row.source_run_id, jobs, generation: row.generation, status: row.status });
  } catch (error: unknown) {
    console.warn("[claude-native] Recovery receipt unavailable", typeof error);
    return null;
  }
}

function sourceMatchesChat(chat: Selectable<ChatsTable>) {
  return chat.lifecycle === "active" && chat.collaboration === null && chat.bound_driver_kind === "claude_code"
    && chat.bound_instance_id !== null && chat.current_selection !== null;
}

/** Call in the scheduled admission transaction after locking and validating the owner Chat. */
export async function verifyClaudeNativeRecoveryGeneration(
  trx: Transaction<ChatDatabase> | Kysely<ChatDatabase>,
  supplied: ClaudeNativeRecoveryAdmissionFence,
  now: Date,
): Promise<boolean> {
  const fence = admissionFenceSchema.parse(supplied);
  const chat = await trx.selectFrom("chats").selectAll().where("id", "=", fence.chatId)
    .where("owner_type", "=", "personal").where("owner_id", "=", fence.ownerId).forUpdate().executeTakeFirst();
  if (!chat || !await matchesSource(trx, chat, fence, true)) return false;
  const row = await trx.selectFrom("chat_claude_native_recovery").selectAll()
    .where("owner_id", "=", fence.ownerId).where("chat_id", "=", fence.chatId)
    .where("session_id", "=", fence.sessionId).where("source_run_id", "=", fence.sourceRunId)
    .where("source_fingerprint", "=", fence.sourceFingerprint).where("generation", "=", fence.generation)
    .where("status", "=", "active").where("deadline_at", ">", now).forUpdate().executeTakeFirst();
  if (!row) return false;
  const jobs = storedJobsSchema.safeParse(parseJson(row.jobs));
  return jobs.success && jobs.data.some(job => job.id === fence.jobId && job.promptSha256 === fence.promptSha256);
}

async function matchesSource(
  trx: Transaction<ChatDatabase> | Kysely<ChatDatabase>, chat: Selectable<ChatsTable>,
  input: Pick<ClaudeNativeRecoveryInput, "sourceRunId" | "sessionId">, completed: boolean,
) {
  if (!sourceMatchesChat(chat)) return false;
  // Include newer runs without a checkpoint, which also supersede the old source.
  const source = await trx.selectFrom("chat_runs as runs")
    .innerJoin("chat_turns as turns", "turns.id", "runs.turn_id")
    .leftJoin("chat_run_adapter_state as checkpoint", join => join.onRef("checkpoint.run_id", "=", "runs.id")
      .on("checkpoint.driver_kind", "=", "claude_code").onRef("checkpoint.instance_id", "=", "runs.instance_id"))
    .selectAll("runs").select("checkpoint.state as native_checkpoint")
    .where("runs.chat_id", "=", chat.id)
    .orderBy("turns.base_message_seq", "desc").orderBy("runs.attempt", "desc")
    .executeTakeFirst();
  if (!source || source.id !== input.sourceRunId) return false;
  const run = toRun(source);
  const completedSuccessfully = run.status === "completed" && run.outcome === "completed";
  const inFlight = ["accepted", "running", "waiting_for_approval", "waiting_for_input"].includes(run.status);
  if (!(completedSuccessfully || (!completed && inFlight)) || run.driverKind !== "claude_code"
    || run.instanceId !== chat.bound_instance_id || run.interactionMode !== "default" || run.context?.agent
    || !isDeepStrictEqual(parseJson(chat.current_selection), run.selection)
    || (chat.project_id ?? undefined) !== (run.executionRoot ? canonicalExecutionRootProjectId(run.executionRoot) : undefined)) return false;
  const checkpoint = sessionStateSchema.safeParse(parseJson(source.native_checkpoint));
  return checkpoint.success && checkpoint.data.sessionId === input.sessionId;
}

export function createClaudeNativeRecoveryStore(database: Kysely<ChatDatabase>, options: { now?: () => Date; recoveryKey?: Buffer } = {}) {
  const clock = options.now ?? (() => new Date());

  async function underChatLock<T>(
    key: Pick<ClaudeNativeRecoveryInput, "ownerId" | "chatId">,
    operation: (trx: Transaction<ChatDatabase>, chat: Selectable<ChatsTable>) => Promise<T>,
  ): Promise<T | null> {
    return database.transaction().execute(async trx => {
      await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      const chat = await trx.selectFrom("chats").selectAll().where("id", "=", key.chatId)
        .where("owner_type", "=", "personal").where("owner_id", "=", key.ownerId).forUpdate().executeTakeFirst();
      return chat ? operation(trx, chat) : null;
    });
  }

  function isCurrent(input: ClaudeNativeRecoveryInput) {
    const now = clock().getTime(), deadline = Date.parse(input.deadlineAt);
    return now < deadline && deadline - now <= maxSessionMs;
  }

  async function transition(
    supplied: ClaudeNativeRecoveryReceipt, transition: "claim" | "release" | "invalidate" | "consume", jobId?: string,
  ) {
    const expected = receiptSchema.parse(supplied);
    const required = transition === "claim" ? "released" : "active";
    if (expected.status === "invalid" || (transition !== "invalidate" && expected.status !== required)) return null;
    if (expected.generation === maxGeneration) return null;
    return underChatLock(expected, async (trx, chat) => {
      const previous = await trx.selectFrom("chat_claude_native_recovery").selectAll()
        .where("chat_id", "=", expected.chatId).where("owner_id", "=", expected.ownerId).executeTakeFirst();
      if (!previous) return null;
      const current = toReceipt(previous, options.recoveryKey);
      if (!current || !isDeepStrictEqual(current, expected)) return null;
      if (transition !== "invalidate" && (!isCurrent(current) || !await matchesSource(trx, chat, current, true))) return null;

      let jobs = storedJobsSchema.parse(parseJson(previous.jobs));
      let status: ClaudeNativeRecoveryReceipt["status"] = transition === "release" ? "released" : "active";
      if (transition === "invalidate") {
        status = "invalid";
        jobs = [];
      } else if (transition === "consume") {
        const job = jobs.find(item => item.id === jobId);
        if (!job || job.recurring) return null;
        jobs = jobs.filter(item => item.id !== jobId);
        if (!jobs.length) status = "invalid";
      }
      const updated = await trx.updateTable("chat_claude_native_recovery")
        .set({ status, jobs: jsonb(jobs), generation: current.generation + 1 })
        .where("chat_id", "=", current.chatId).where("owner_id", "=", current.ownerId)
        .where("generation", "=", current.generation).where("status", "=", current.status)
        .returningAll().executeTakeFirst();
      return updated ? toReceipt(updated, options.recoveryKey) : null;
    });
  }

  return {
    async saveActive(value: ClaudeNativeRecoveryInput, expectedGeneration?: number): Promise<ClaudeNativeRecoveryReceipt | null> {
      const input = inputSchema.parse(value);
      if (!input.jobs.length || !isCurrent(input)) return null;
      const encoded = encodeJobs(input, options.recoveryKey);
      if (!encoded) return null;
      if (expectedGeneration !== undefined) z.number().int().min(1).max(maxGeneration).parse(expectedGeneration);
      return underChatLock(input, async (trx, chat) => {
        if (!isCurrent(input) || !await matchesSource(trx, chat, input, false)) return null;
        const common = { session_id: input.sessionId, source_run_id: input.sourceRunId,
          source_fingerprint: input.sourceFingerprint, deadline_at: input.deadlineAt, jobs: jsonb(encoded), status: "active" as const };
        if (expectedGeneration === undefined) {
          const created = await trx.insertInto("chat_claude_native_recovery")
            .values({ ...common, chat_id: input.chatId, owner_id: input.ownerId, generation: 1 })
            .onConflict(conflict => conflict.column("chat_id").doNothing()).returningAll().executeTakeFirst();
          if (created) return toReceipt(created, options.recoveryKey);
        }
        const existing = await trx.selectFrom("chat_claude_native_recovery").selectAll()
          .where("chat_id", "=", input.chatId).where("owner_id", "=", input.ownerId)
          .executeTakeFirst();
        if (!existing || existing.generation === maxGeneration) return null;
        const sameSession = existing.session_id === input.sessionId;
        if (expectedGeneration === undefined) {
          // A different session on the locked latest source supersedes old authority.
          // Continuing the same session still requires the caller's existing generation.
          if (sameSession || existing.source_run_id === input.sourceRunId) return null;
        } else {
          if (existing.generation !== expectedGeneration || existing.status === "released") return null;
          if (sameSession && (asIso(existing.deadline_at) !== input.deadlineAt || existing.source_fingerprint !== input.sourceFingerprint)) return null;
          if (!sameSession && existing.status !== "invalid") return null;
        }
        const updated = await trx.updateTable("chat_claude_native_recovery")
          .set({ ...common, generation: existing.generation + 1 })
          .where("chat_id", "=", input.chatId).where("owner_id", "=", input.ownerId)
          .where("generation", "=", existing.generation).where("status", "=", existing.status)
          .returningAll().executeTakeFirst();
        return updated ? toReceipt(updated, options.recoveryKey) : null;
      });
    },
    async listRecoverable(ownerIdValue: string): Promise<ClaudeNativeRecoveryReceipt[]> {
      const ownerId = ownerIdSchema.parse(ownerIdValue);
      const rows = await database.selectFrom("chat_claude_native_recovery as receipt")
        .innerJoin("chats as chat", "chat.id", "receipt.chat_id").selectAll("receipt")
        .where("receipt.owner_id", "=", ownerId).where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", ownerId)
        .where("chat.lifecycle", "=", "active").where("chat.collaboration", "is", null)
        .where("chat.bound_driver_kind", "=", "claude_code")
        .where("receipt.status", "=", "released").where("receipt.deadline_at", ">", clock())
        // Discard superseded sources before applying the recovery scan cap. The claim repeats the check under lock.
        .where(eb => eb("receipt.source_run_id", "=", eb.selectFrom("chat_runs as latest")
          .innerJoin("chat_turns as turn", "turn.id", "latest.turn_id")
          .select("latest.id").whereRef("latest.chat_id", "=", "receipt.chat_id")
          .orderBy("turn.base_message_seq", "desc").orderBy("latest.attempt", "desc").limit(1)))
        .orderBy("receipt.deadline_at", "asc").orderBy("receipt.chat_id", "asc").limit(maxRecoverableSessions).execute();
      return rows.map(row => toReceipt(row, options.recoveryKey)).filter(receipt => receipt !== null);
    },
    claim: (receipt: ClaudeNativeRecoveryReceipt) => transition(receipt, "claim"),
    release: (receipt: ClaudeNativeRecoveryReceipt) => transition(receipt, "release"),
    invalidate: (receipt: ClaudeNativeRecoveryReceipt) => transition(receipt, "invalidate"),
    consume: (receipt: ClaudeNativeRecoveryReceipt, jobId: string) => transition(receipt, "consume", jobIdSchema.parse(jobId)),
  };
}
