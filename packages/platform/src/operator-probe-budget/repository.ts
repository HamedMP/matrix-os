import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  OperatorProbeBeginSchema, OperatorProbeBudgetConfigSchema, OperatorProbeFinalizeSchema,
  OperatorProbeAttemptLookupSchema, priceOperatorProbeUsageMicrousd,
  type OperatorProbeAttempt, type OperatorProbeBudgetConfig, type OperatorProbeBudgetStore,
  type OperatorProbeReceipt,
} from '@matrix-os/contracts/funded-operator-probe';
import type { OperatorProbeDatabase } from './database.js';
export class OperatorProbeBudgetError extends Error {
  constructor(readonly reason: 'conflict' | 'unavailable') { super('Operator probe budget request failed'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
interface WalletRow {
  config: OperatorProbeBudgetConfig; config_hash: string; held_microusd: string;
  settled_microusd: string; frozen: boolean; attempt_count: number;
}
/** Explicit operator action only. Exact configuration replay cannot refill or reset a wallet. */
export async function initializeOperatorProbeBudget(db: Kysely<OperatorProbeDatabase>, raw: OperatorProbeBudgetConfig): Promise<void> {
  const config = OperatorProbeBudgetConfigSchema.parse(raw), configHash = hash(config);
  await db.transaction().execute(async tx => {
    await sql`INSERT INTO operator_probe_wallets (budget_id, config, config_hash)
      VALUES (${config.budgetId}, ${JSON.stringify(config)}::jsonb, ${configHash}) ON CONFLICT (budget_id) DO NOTHING`.execute(tx);
    const row = await sql<{ config_hash: string }>`SELECT config_hash FROM operator_probe_wallets
      WHERE budget_id=${config.budgetId} FOR UPDATE`.execute(tx);
    if (row.rows[0]?.config_hash !== configHash) throw new OperatorProbeBudgetError('conflict');
  });
}
export function createOperatorProbeBudgetRepository<DB extends OperatorProbeDatabase>(options: {
  db: Kysely<DB>; budgetId: string; now?: () => Date;
}): OperatorProbeBudgetStore {
  const { db, budgetId } = options;
  if (!budgetId || budgetId.length > 160) throw new Error('Operator probe budget configuration is required');
  const now = options.now ?? (() => new Date());
  async function wallet(tx: Transaction<DB>) {
    const result = await sql<WalletRow>`SELECT * FROM operator_probe_wallets WHERE budget_id=${budgetId} FOR UPDATE`.execute(tx);
    if (!result.rows[0]) throw new OperatorProbeBudgetError('unavailable');
    return result.rows[0];
  }
  async function attempt(connection: Kysely<DB>, probeId: string) {
    const result = await sql<{ attempt: OperatorProbeAttempt }>`SELECT attempt FROM operator_probe_attempts
      WHERE budget_id=${budgetId} AND probe_id=${probeId}`.execute(connection);
    return result.rows[0]?.attempt ?? null;
  }
  return {
    async begin(raw) {
      const input = OperatorProbeBeginSchema.parse(raw);
      const economicHash = hash({ protocolVersion: input.protocolVersion, policy: input.policy });
      return db.transaction().execute(async tx => {
        const row = await wallet(tx);
        const existing = await attempt(tx, input.probeId);
        if (existing) {
          if (existing.economicHash !== economicHash) throw new OperatorProbeBudgetError('conflict');
          return { dispatchGranted: false, attempt: existing };
        }
        const timestamp = now();
        const policy = row.config.policies.find(p => p.canonicalModelId === input.policy.canonicalModelId);
        if (!policy || hash(policy) !== hash(input.policy)) throw new OperatorProbeBudgetError('conflict');
        const hold = BigInt(policy.maximumCostMicrousd);
        if (!Number.isFinite(timestamp.getTime()) || row.frozen || !row.config.enabled || row.attempt_count >= 10000
          || timestamp.getTime() >= Date.parse(row.config.expiresAt) || timestamp.getTime() >= Date.parse(policy.pricingValidThrough)
          || BigInt(row.held_microusd) + BigInt(row.settled_microusd) + BigInt(row.config.historicalReserveMicrousd) + hold > BigInt(row.config.allocationMicrousd)) {
          throw new OperatorProbeBudgetError('unavailable');
        }
        const created: OperatorProbeAttempt = { protocolVersion: 1, probeId: input.probeId, executionId: input.executionId,
          policy, economicHash, status: 'started', startedAt: timestamp.toISOString(), receipt: null };
        await sql`UPDATE operator_probe_wallets SET held_microusd=held_microusd+${hold.toString()}::bigint,
          attempt_count=attempt_count+1 WHERE budget_id=${budgetId}`.execute(tx);
        await sql`INSERT INTO operator_probe_attempts (budget_id,probe_id,attempt)
          VALUES (${budgetId},${input.probeId},${JSON.stringify(created)}::jsonb)`.execute(tx);
        return { dispatchGranted: true, attempt: created };
      });
    },
    async finalize(raw) {
      const input = OperatorProbeFinalizeSchema.parse(raw), payloadHash = hash(input);
      return db.transaction().execute(async tx => {
        await wallet(tx);
        const existing = await attempt(tx, input.probeId);
        if (!existing || existing.executionId !== input.executionId || existing.economicHash !== input.economicHash) {
          throw new OperatorProbeBudgetError('conflict');
        }
        const saved = await sql<{ receipt: OperatorProbeReceipt }>`SELECT receipt FROM operator_probe_receipts
          WHERE budget_id=${budgetId} AND probe_id=${input.probeId} AND payload_hash=${payloadHash}`.execute(tx);
        if (saved.rows[0]) return saved.rows[0].receipt;
        // At most one unresolved and one resolving receipt; other changed replays conflict.
        if (existing.status === 'settled' || existing.status === 'discrepancy') throw new OperatorProbeBudgetError('conflict');
        let cost: number | null = null;
        let discrepancy = false;
        if (input.usage) {
          const usage = input.usage;
          discrepancy = usage.outputTokens > existing.policy.maximumOutputTokens
            || BigInt(usage.inputTokens) + BigInt(usage.cacheReadTokens) + BigInt(usage.cacheWrite5mTokens) + BigInt(usage.cacheWrite1hTokens) > BigInt(existing.policy.maximumInputTokens);
          try { cost = priceOperatorProbeUsageMicrousd(existing.policy, usage); }
          catch (error: unknown) {
            if (!(error instanceof Error)) throw error;
            // Unrepresentable attributable costs are retained as a discrepancy, never refunded.
            discrepancy = true;
          }
          discrepancy ||= cost !== null && cost > existing.policy.maximumCostMicrousd;
        }
        const status = discrepancy ? 'discrepancy' : input.outcome === 'unknown' || cost === null ? 'unknown' : 'settled';
        if (existing.status === 'unknown' && status === 'unknown') throw new OperatorProbeBudgetError('conflict');
        // Nonterminal counts may be partial; retain the maximum liability, never publish them as final cost.
        if (status === 'unknown') cost = null;
        const body = { payloadHash, status, outcome: input.outcome, costMicrousd: cost,
          ...(input.providerLogId ? { providerLogId: input.providerLogId } : {}),
          usage: input.usage, providerReferenceHash: input.providerReferenceHash, finalizedAt: now().toISOString() } as const;
        const receipt: OperatorProbeReceipt = { ...body, receiptHash: hash({ probeId: input.probeId,
          executionId: input.executionId, economicHash: input.economicHash, ...body }) };
        if (status === 'settled') {
          await sql`UPDATE operator_probe_wallets SET held_microusd=held_microusd-${existing.policy.maximumCostMicrousd}::bigint,
            settled_microusd=settled_microusd+${cost}::bigint WHERE budget_id=${budgetId}`.execute(tx);
        } else if (status === 'discrepancy') {
          await sql`UPDATE operator_probe_wallets SET frozen=true WHERE budget_id=${budgetId}`.execute(tx);
        }
        await sql`INSERT INTO operator_probe_receipts (budget_id,probe_id,payload_hash,receipt)
          VALUES (${budgetId},${input.probeId},${payloadHash},${JSON.stringify(receipt)}::jsonb)`.execute(tx);
        await sql`UPDATE operator_probe_attempts SET attempt=${JSON.stringify({ ...existing, status, receipt })}::jsonb
          WHERE budget_id=${budgetId} AND probe_id=${input.probeId}`.execute(tx);
        return receipt;
      });
    },
    getAttempt(probeId) { return attempt(db, OperatorProbeAttemptLookupSchema.parse({ probeId }).probeId); },
    async getStatus() {
      const result = await sql<WalletRow>`SELECT * FROM operator_probe_wallets WHERE budget_id=${budgetId}`.execute(db);
      const row = result.rows[0];
      if (!row) return null;
      return { ...row.config, heldMicrousd: Number(row.held_microusd), settledMicrousd: Number(row.settled_microusd),
        frozen: row.frozen, attemptCount: row.attempt_count,
        availableMicrousd: Number(BigInt(row.config.allocationMicrousd) - BigInt(row.config.historicalReserveMicrousd)
          - BigInt(row.held_microusd) - BigInt(row.settled_microusd)) };
    },
  };
}
