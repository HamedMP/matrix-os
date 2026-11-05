import { createHash } from 'node:crypto';
import { normalizeOperatorServiceOrigin, operatorProbeRpc, OperatorProbeGrantSchema, OperatorProbeReceiptSchema,
  OperatorProbeAttemptSchema, OperatorProbeBudgetStatusSchema, type OperatorProbeBudgetStore } from '@matrix-os/contracts/funded-operator-probe';
import type { PlatformDB } from '../db.js';
import { probeWithSignal } from '../ai-funded-jev-probe.js';
import { createOperatorProbeBudgetRepository } from './repository.js';
import type { OperatorProbeDatabase } from './database.js';
import { OPERATOR_PROBE_AUTHORITY_BASE } from './routes.js';

export interface OperatorProbePlacement {
  store: OperatorProbeBudgetStore; budgetId: string; relayOrigin: string; namespace: string; close(): Promise<void>;
}

/** Only explicit operator service origins. Neither authority URL nor Relay URL falls back to customer inference. */
export function configureOperatorProbes(env: NodeJS.ProcessEnv, db: PlatformDB, relayToken: string, fetchFn = fetch): OperatorProbePlacement | undefined {
  const budgetId = env.MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID;
  if (budgetId === undefined) return undefined;
  if (!budgetId.trim() || budgetId.length > 160) throw new Error('Operator budget identifier required');
  const relayOrigin = normalizeOperatorServiceOrigin(env.MATRIX_FUNDED_AI_OPERATOR_PROBE_RELAY_URL ?? '');
  const authority = env.MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_URL;
  const token = env.MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN;
  let backend: OperatorProbeBudgetStore;
  if (authority !== undefined) {
    if (!token || token.length < 32 || token.length > 4096 || [relayToken, env.PLATFORM_SECRET,
      env.AI_FUNDED_CREDENTIAL_HASH_SECRET].includes(token)) throw new Error('Separate authority credential required');
    const expectedWallet = createHash('sha256').update(budgetId).digest('hex');
    const rpc = operatorProbeRpc(authority, OPERATOR_PROBE_AUTHORITY_BASE, token, fetchFn,
      { 'if-match': '"' + expectedWallet + '"' });
    backend = {
      begin: input => rpc('begin', { operation: input }, OperatorProbeGrantSchema),
      finalize: input => rpc('finalize', { operation: input }, OperatorProbeReceiptSchema),
      getAttempt: probeId => rpc('attempt', { probeId }, OperatorProbeAttemptSchema.nullable(), 2000),
      getStatus: () => rpc('status', undefined, OperatorProbeBudgetStatusSchema.nullable(), 2000),
    };
  } else {
    // Platform startup already runs the additive operator schema migration on its own pool.
    backend = createOperatorProbeBudgetRepository({ db: db.kysely.withTables<OperatorProbeDatabase>(), budgetId });
  }
  const namespace = createHash('sha256').update(JSON.stringify(['operator-probe-v1', budgetId, authority ?? 'local', token, relayOrigin])).digest('hex');
  const active = new Set<Promise<unknown>>();
  let closed = false;
  async function bounded<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (closed || active.size >= 128) throw new Error('Operator probe authority unavailable');
    const operation = work();
    active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
    return probeWithSignal(() => operation, AbortSignal.timeout(timeoutMs));
  }
  const store: OperatorProbeBudgetStore = {
    begin: input => bounded(() => backend.begin(input), 3000),
    finalize: input => bounded(() => backend.finalize(input), 3000),
    getAttempt: probeId => bounded(() => backend.getAttempt(probeId), 2000),
    getStatus: () => bounded(() => backend.getStatus(), 2000),
  };
  return { store, budgetId, relayOrigin, namespace, async close() {
    closed = true;
    await Promise.allSettled([...active]);
  } };
}
