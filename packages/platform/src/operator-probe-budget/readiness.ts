import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { OperatorProbePolicySchema } from '@matrix-os/contracts/funded-operator-probe';
import { cancelProbeBody, probeWithSignal } from '../ai-funded-jev-probe.js';
import type { OperatorProbePlacement } from './adapter.js';

/** Cache keys include stable economics and placement, never transient spend or owner identity. */
export async function currentOperatorPolicy(operator: OperatorProbePlacement, model: string, now: () => Date, signal: AbortSignal) {
  const wallet = await probeWithSignal(() => operator.store.getStatus(), signal);
  const price = wallet?.policies.find(p => p.canonicalModelId === model);
  if (!wallet?.enabled || wallet.frozen || wallet.budgetId !== operator.budgetId || !price
    || Date.parse(wallet.expiresAt) <= +now() || Date.parse(price.pricingValidThrough) <= +now()) return undefined;
  // Zod supplies deterministic field order for both jsonb and HTTP rows.
  const policy = OperatorProbePolicySchema.parse(price);
  const cacheScope = createHash('sha256').update(JSON.stringify([operator.namespace, wallet.walletBinding, wallet.revision, wallet.expiresAt, policy])).digest('hex');
  return { policy, cacheScope, walletBinding: wallet.walletBinding, walletExpiry: wallet.expiresAt };
}
export async function runOperatorProbe(input: {
  operator: OperatorProbePlacement; model: string; probeId: string; token: string;
  fetchFn: typeof fetch; now: () => Date; signal: AbortSignal; cacheScope: string; walletBinding: string;
}) {
  const { operator, model, probeId, signal } = input;
  const relaySignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  try {
    const response = await probeWithSignal(() => input.fetchFn(operator.relayOrigin + '/ready', {
      method: 'POST', redirect: 'error', signal: relaySignal,
      headers: { authorization: 'Bearer ' + input.token, 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, model, probeId, walletBinding: input.walletBinding }),
    }), relaySignal);
    cancelProbeBody(response.body);
  } catch (error: unknown) {
    // Even a lost HTTP acknowledgement may follow a committed settlement.
    console.warn('[operator-probe] Relay acknowledgement unavailable', { aborted: relaySignal.aborted });
  }
  const readSignal = AbortSignal.any([signal, AbortSignal.timeout(2_000)]);
  const [attempt, context] = await Promise.all([
    probeWithSignal(() => operator.store.getAttempt(probeId), readSignal),
    currentOperatorPolicy(operator, model, input.now, readSignal),
  ]);
  const receipt = attempt?.receipt;
  if (!context || context.cacheScope !== input.cacheScope || attempt?.protocolVersion !== 1 || attempt.probeId !== probeId
    || attempt.walletBinding !== input.walletBinding || context.walletBinding !== input.walletBinding || attempt.status !== 'settled' || receipt?.status !== 'settled' || receipt.outcome !== 'ready'
    || !receipt.usage || receipt.costMicrousd === null || !receipt.providerReferenceHash
    || !isDeepStrictEqual(attempt.policy, context.policy)) return undefined;
  return context;
}
