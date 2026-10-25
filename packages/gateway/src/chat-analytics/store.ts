import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { boundedProvenanceTransaction } from "../google-data/provenance/transaction.js";
import { lockGoogleContexts } from "../google-data/runtime/contexts-schema.js";
import { createGoogleModelHistoryStore } from "../google-data/runtime/model-history.js";
import { AdmissionLeaseSchema, ChatAnalyticsTagsSchema, ChatAnalyticsUnavailable, CompletedGenerationSchema,
  GenerationBindingSchema, GenerationFactsSchema, OwnerPolicySchema, type AdmissionLease, type CompletedGeneration,
  type GenerationBinding } from "./contracts.js";
import { migrateChatAnalytics } from "./migration.js";
import { aggregateChatAnalytics, ordinaryGenerationFilter } from "./aggregation.js";

interface GenerationRow {
  generation_id: string; owner_id: string; chat_id: string; run_id: string; runtime_handle: string;
  execution_generation: string; request_id: string; owner_epoch: string; chat_epoch: string;
  captured_at: Date | string; facts: unknown; sampled: boolean; sample_rate_bp: number;
}
const iso = (value: Date | string) => new Date(value).toISOString();
/** All tables are in the injected owner-controlled PostgreSQL database. No pool ownership transfer. */
export function createChatAnalyticsStore<DB>(db: Kysely<DB>, options: { now?: () => Date; retentionDays?: number;
  maxGenerations?: number; maxGenerationsPerOwner?: number } = {}) {
  const now = options.now ?? (() => new Date()); const retention = options.retentionDays ?? 30;
  const maxRows = options.maxGenerations ?? 200_000; const maxOwnerRows = options.maxGenerationsPerOwner ?? 10_000;
  if (![retention, maxRows, maxOwnerRows].every(x => Number.isSafeInteger(x) && x > 0)
    || retention > 30 || maxRows > 200_000 || maxOwnerRows > 10_000) throw new ChatAnalyticsUnavailable();
  const ownerKey = (ownerId: string) => GenerationBindingSchema.shape.ownerId.parse(ownerId);
  async function locked<T>(work: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return boundedProvenanceTransaction(db, async tx => { await lockGoogleContexts(tx); return work(tx); });
  }
  async function ordinary(tx: Kysely<DB>, binding: GenerationBinding) {
    const owned = (await sql`SELECT 1 FROM chats c JOIN chat_runs r ON r.chat_id=c.id
      WHERE c.id=${binding.chatId} AND c.owner_type='personal' AND c.owner_id=${binding.ownerId}
        AND c.lifecycle='active' AND c.collaboration IS NULL AND r.id=${binding.runId}
        AND r.status IN ('accepted','running','waiting_for_approval','waiting_for_input','completed')
        AND (r.outcome IS NULL OR r.outcome='completed')`.execute(tx)).rows.length === 1;
    return owned && (await createGoogleModelHistoryStore(tx, { now }).inspect({ type: "personal", ownerId: binding.ownerId }, binding.chatId)).classification === "ordinary";
  }
  async function currentLease(tx: Kysely<DB>, binding: GenerationBinding): Promise<AdmissionLease | null> {
    const row = (await sql<{ owner_epoch: string; chat_epoch: string; sample_rate_bp: number }>`SELECT
      p.policy_epoch AS owner_epoch,s.scope_epoch AS chat_epoch,p.sample_rate_bp
      FROM chat_analytics_owner_policy p JOIN chat_analytics_scopes s ON s.owner_id=p.owner_id
      WHERE p.owner_id=${binding.ownerId} AND p.enabled AND s.chat_id=${binding.chatId}`.execute(tx)).rows[0];
    return row ? AdmissionLeaseSchema.parse({ ownerEpoch: row.owner_epoch, chatEpoch: row.chat_epoch, sampleRateBps: row.sample_rate_bp }) : null;
  }
  async function valid(tx: Kysely<DB>, completed: CompletedGeneration) {
    const lease = await currentLease(tx, completed.binding);
    return lease !== null && lease.ownerEpoch === completed.lease.ownerEpoch && lease.chatEpoch === completed.lease.chatEpoch
      && lease.sampleRateBps === completed.lease.sampleRateBps && await ordinary(tx, completed.binding);
  }
  async function generation(tx: Kysely<DB>, completed: CompletedGeneration): Promise<GenerationRow | undefined> {
    const b = completed.binding;
    return (await sql<GenerationRow>`SELECT g.* FROM chat_analytics_generations g
      WHERE g.generation_id=${completed.generationId} AND g.owner_id=${b.ownerId} AND g.chat_id=${b.chatId}
        AND g.run_id=${b.runId} AND g.runtime_handle=${b.runtimeHandle} AND g.execution_generation=${b.executionGeneration}
        AND g.request_id=${b.requestId} AND g.owner_epoch=${completed.lease.ownerEpoch}::uuid AND g.chat_epoch=${completed.lease.chatEpoch}::uuid
        AND g.expires_at>${now()} FOR UPDATE`.execute(tx)).rows[0];
  }
  function matches(row: GenerationRow | undefined, completed: CompletedGeneration) {
    return Boolean(row && row.sampled === completed.sampled && row.sample_rate_bp === completed.lease.sampleRateBps
      && iso(row.captured_at) === completed.capturedAt
      && JSON.stringify(GenerationFactsSchema.parse(row.facts)) === JSON.stringify(completed.facts));
  }
  return {
    async migrate() { await createGoogleModelHistoryStore(db, { now }).migrate(); await migrateChatAnalytics(db); },
    async getOwnerPolicy(ownerId: string) {
      const id = ownerKey(ownerId);
      const row = await boundedProvenanceTransaction(db, async tx => (await sql<{ enabled: boolean; sample_rate_bp: number }>`SELECT enabled,sample_rate_bp
        FROM chat_analytics_owner_policy WHERE owner_id=${id}`.execute(tx)).rows[0]);
      return row ? { enabled: row.enabled, sampleRateBps: row.sample_rate_bp } : null;
    },
    async configureOwner(ownerId: string, input: unknown) {
      const id = ownerKey(ownerId); const policy = OwnerPolicySchema.parse(input);
      await locked(async tx => {
        await sql`INSERT INTO chat_analytics_owner_policy(owner_id,enabled,sample_rate_bp,policy_epoch)
          SELECT ${id},${policy.enabled},${policy.sampleRateBps},${randomUUID()}::uuid
          WHERE EXISTS(SELECT 1 FROM chat_analytics_owner_policy WHERE owner_id=${id})
            OR (SELECT count(*) FROM chat_analytics_owner_policy)<200000
          ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled,sample_rate_bp=excluded.sample_rate_bp,policy_epoch=excluded.policy_epoch`.execute(tx);
      });
    },
    async inspectAdmission(input: GenerationBinding): Promise<AdmissionLease | null> {
      const binding = GenerationBindingSchema.parse(input);
      return locked(async tx => {
        const policy = (await sql`SELECT 1 FROM chat_analytics_owner_policy WHERE owner_id=${binding.ownerId} AND enabled`.execute(tx)).rows[0];
        if (!policy || !await ordinary(tx, binding)) return null;
        await sql`INSERT INTO chat_analytics_scopes(owner_id,chat_id,scope_epoch)
          SELECT ${binding.ownerId},${binding.chatId},${randomUUID()}::uuid
          WHERE (SELECT count(*) FROM chat_analytics_scopes)<200000
            AND (SELECT count(*) FROM chat_analytics_scopes WHERE owner_id=${binding.ownerId})<10000
          ON CONFLICT(owner_id,chat_id) DO NOTHING`.execute(tx);
        return currentLease(tx, binding);
      });
    },
    async recordCompleted(input: unknown): Promise<boolean> {
      const parsed = CompletedGenerationSchema.safeParse(input); if (!parsed.success) return false;
      const completed = parsed.data; const b = completed.binding; const at = now();
      if (Date.parse(completed.capturedAt) > Date.parse(completed.facts.completedAt)
        || Date.parse(completed.facts.completedAt) > at.getTime() + 60_000
        || Date.parse(completed.facts.completedAt) + retention * 86_400_000 <= at.getTime()) return false;
      return locked(async tx => {
        if (!await valid(tx, completed)) return false;
        await sql`INSERT INTO chat_analytics_generations(generation_id,owner_id,chat_id,run_id,runtime_handle,execution_generation,request_id,
          owner_epoch,chat_epoch,captured_at,completed_at,expires_at,sample_rate_bp,sampled,facts)
          SELECT ${completed.generationId}::uuid,${b.ownerId},${b.chatId},${b.runId},${b.runtimeHandle},${b.executionGeneration},${b.requestId},
            ${completed.lease.ownerEpoch}::uuid,${completed.lease.chatEpoch}::uuid,${completed.capturedAt}::timestamptz,${completed.facts.completedAt}::timestamptz,
            ${new Date(Date.parse(completed.facts.completedAt) + retention * 86_400_000)},${completed.lease.sampleRateBps},${completed.sampled},${JSON.stringify(completed.facts)}::jsonb
          WHERE (SELECT count(*) FROM chat_analytics_generations)<${maxRows}
            AND (SELECT count(*) FROM chat_analytics_generations WHERE owner_id=${b.ownerId})<${maxOwnerRows}
          ON CONFLICT DO NOTHING`.execute(tx);
        return matches(await generation(tx, completed), completed);
      });
    },
    async revalidateGeneration(input: unknown): Promise<boolean> {
      const parsed = CompletedGenerationSchema.safeParse(input); if (!parsed.success) return false;
      return locked(async tx => await valid(tx, parsed.data) && matches(await generation(tx, parsed.data), parsed.data));
    },
    async commitTags(input: unknown, tagsInput: unknown, signal?: AbortSignal): Promise<boolean> {
      const completed = CompletedGenerationSchema.parse(input); const tags = ChatAnalyticsTagsSchema.parse(tagsInput);
      if (!completed.sampled) return false;
      return locked(async tx => {
        const active = () => { if (signal?.aborted) throw new ChatAnalyticsUnavailable(); };
        active();
        if (!await valid(tx, completed) || !matches(await generation(tx, completed), completed)) return false;
        active();
        const updated = await sql`UPDATE chat_analytics_generations SET task_family=${tags.taskFamily},task_type=${tags.taskType},
          complexity=${tags.complexity},confidence_self_reported=${tags.confidence ?? null},taxonomy_version=1,classified_at=${now()}
          WHERE generation_id=${completed.generationId}::uuid AND owner_id=${completed.binding.ownerId}
            AND owner_epoch=${completed.lease.ownerEpoch}::uuid AND chat_epoch=${completed.lease.chatEpoch}::uuid
            AND classified_at IS NULL RETURNING generation_id`.execute(tx);
        active();
        return updated.rows.length === 1;
      });
    },
    async aggregate(input: unknown) { return locked(tx => aggregateChatAnalytics(tx, input, now())); },
    async deleteOwner(ownerId: string) {
      const id = ownerKey(ownerId);
      await locked(async tx => { await sql`DELETE FROM chat_analytics_owner_policy WHERE owner_id=${id}`.execute(tx); });
    },
    async deleteChat(ownerId: string, chatId: string) {
      const id = ownerKey(ownerId); const chat = GenerationBindingSchema.shape.chatId.parse(chatId);
      await locked(async tx => {
        await sql`UPDATE chat_analytics_scopes SET scope_epoch=${randomUUID()}::uuid WHERE owner_id=${id} AND chat_id=${chat}`.execute(tx);
        await sql`DELETE FROM chat_analytics_generations WHERE owner_id=${id} AND chat_id=${chat}`.execute(tx);
      });
    },
    async expire() {
      return locked(async tx => {
        const result = await sql`DELETE FROM chat_analytics_generations WHERE generation_id IN
          (SELECT g.generation_id FROM chat_analytics_generations g WHERE g.expires_at<=${now()} OR NOT (${ordinaryGenerationFilter()})
            ORDER BY g.expires_at LIMIT 1000) RETURNING generation_id`.execute(tx);
        return result.rows.length;
      });
    },
  };
}
export type ChatAnalyticsStore = ReturnType<typeof createChatAnalyticsStore>;
