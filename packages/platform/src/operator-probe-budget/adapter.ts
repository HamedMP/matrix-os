import { createHash } from 'node:crypto';
import { normalizeOperatorServiceOrigin, operatorProbeRpc, BoundOperatorGrant, BoundOperatorReceipt, assertOperatorReply, OperatorProbeHashSchema,
  OperatorProbeAttemptSchema, OperatorProbeBudgetStatusSchema, type OperatorProbeBudgetStore } from '@matrix-os/contracts/funded-operator-probe';
import { createOperatorGrantDrain } from './shutdown.js';
import { probeWithSignal } from '../ai-funded-jev-probe.js';
import { createOperatorProbeBudgetRepository } from './repository.js';
import { createOperatorProbeBudgetDatabase } from './database.js';
import { OPERATOR_PROBE_AUTHORITY_BASE } from './routes.js';

export interface OperatorProbePlacement {
  store: OperatorProbeBudgetStore; budgetId: string; relayOrigin: string; namespace: string; quiesce(): Promise<void>; close(): Promise<void>;
}

/** Only explicit operator service origins. Neither authority URL nor Relay URL falls back to customer inference. */
export function configureOperatorProbes(env: NodeJS.ProcessEnv, platformDatabaseUrl: string, relayToken: string, fetchFn = fetch): OperatorProbePlacement | undefined {
  const budgetId = env.MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID;
  if (budgetId === undefined) return undefined;
  if (!budgetId.trim() || budgetId.length > 160) throw new Error('Operator budget identifier required');
  const relayOrigin = normalizeOperatorServiceOrigin(env.MATRIX_FUNDED_AI_OPERATOR_PROBE_RELAY_URL ?? '');
  const authority = env.MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_URL;
  const token = env.MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN;
  let backend: OperatorProbeBudgetStore;
  let ownedDb: ReturnType<typeof createOperatorProbeBudgetDatabase> | undefined;
  if (authority !== undefined) {
    if (!token || token.length < 32 || token.length > 4096 || [relayToken, env.PLATFORM_SECRET,
      env.AI_FUNDED_CREDENTIAL_HASH_SECRET].includes(token)) throw new Error('Separate authority credential required');
    const expectedWallet = createHash('sha256').update(budgetId).digest('hex');
    const rpc = operatorProbeRpc(authority, OPERATOR_PROBE_AUTHORITY_BASE, token, fetchFn,
      { 'if-match': '"' + expectedWallet + '"' });
    backend = {
      begin: async (operation, walletBinding) => assertOperatorReply(
        await rpc('begin', { operation, walletBinding }, BoundOperatorGrant), OperatorProbeHashSchema.parse(walletBinding)),
      finalize: async (operation, walletBinding) => assertOperatorReply(
        await rpc('finalize', { operation, walletBinding }, BoundOperatorReceipt), OperatorProbeHashSchema.parse(walletBinding)),
      getAttempt: probeId => rpc('attempt', { probeId }, OperatorProbeAttemptSchema.nullable(), 2000),
      getStatus: () => rpc('status', undefined, OperatorProbeBudgetStatusSchema.nullable(), 2000),
    };
  } else {
    if (!platformDatabaseUrl) throw new Error('Operator local Platform database configuration required');
    ownedDb = createOperatorProbeBudgetDatabase(platformDatabaseUrl, true);
    backend = createOperatorProbeBudgetRepository({ db: ownedDb, budgetId });
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
  const grants = createOperatorGrantDrain();
  const store: OperatorProbeBudgetStore = {
    async begin(input, expectedBinding) {
      const binding = OperatorProbeHashSchema.parse(expectedBinding);
      const finish = grants.track(input, binding);
      try {
        const grant = await bounded(() => backend.begin(input, binding), 3000);
        if (!grant.dispatchGranted) finish();
        return grant;
      } catch (error) { finish(); throw error; }
    },
    async finalize(input, expectedBinding) {
      const binding = OperatorProbeHashSchema.parse(expectedBinding);
      const receipt = await bounded(() => backend.finalize(input, binding), 3000);
      grants.finalized(input.probeId, input.executionId, binding);
      return receipt;
    },
    getAttempt: probeId => bounded(() => backend.getAttempt(probeId), 2000),
    getStatus: () => bounded(() => backend.getStatus(), 2000),
  };
  let closing: Promise<void> | undefined;
  return { store, budgetId, relayOrigin, namespace, quiesce: grants.quiesce, close() {
    closed = true;
    grants.close();
    return closing ??= Promise.allSettled([...active]).then(() => ownedDb?.destroy());
  } };
}
