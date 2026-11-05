import { createHmac, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod/v4';
import type { OperatorProbeRequestSchema, OperatorProbeFinalizeInput } from '@matrix-os/contracts/funded-operator-probe';
import type { FundedRelayConfig } from './funded-relay-config.js';
import { createOperatorProbeControlClient } from './funded-relay-platform-client.js';
import { workersAiTarget } from './funded-relay-openai-request.js';
import { FUNDED_SONNET } from './funded-relay-readiness.js';
import { operatorProbePolicy, operatorProbeBody } from './operator-probe-price.js';
import { operatorProbeEvidence } from './operator-probe-usage.js';
import { waitForRelayWork } from './funded-relay-lifecycle.js';

export function createOperatorProbeExecutor(config: FundedRelayConfig, fetchFn: typeof fetch, now: () => Date) {
  const control = createOperatorProbeControlClient(config, fetchFn);
  const active = new Set<Promise<void>>();
  const shutdown = new AbortController();
  async function execute({ model, probeId, protocolVersion }: z.infer<typeof OperatorProbeRequestSchema>, caller: AbortSignal) {
    const policy = operatorProbePolicy(model, now(), config.pricingReviews);
    const executionId = randomUUID();
    const providerReferenceHash = createHmac('sha256', config.metadataSecret)
      .update(JSON.stringify(['operator-probe-v1', probeId, executionId])).digest('hex');
    const headers = new Headers({ 'content-type': 'application/json', connection: 'close',
      'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1', 'cf-aig-collect-log-payload': 'false',
      'cf-aig-metadata': JSON.stringify({ probe_ref: providerReferenceHash }) });
    let url: string;
    if (model === FUNDED_SONNET) {
      url = config.gatewayBaseUrl + '/v1/messages';
      headers.set('cf-aig-authorization', 'Bearer ' + config.gatewayToken);
      headers.set('anthropic-version', '2023-06-01');
    } else {
      if (!config.workersAiToken || config.reservationMode !== 'usage') throw new Error('Probe route unavailable');
      const target = workersAiTarget(config.gatewayBaseUrl, model);
      url = target.url;
      headers.set('authorization', 'Bearer ' + config.workersAiToken);
      headers.set('cf-aig-gateway-id', target.gatewayId);
    }
    const signal = AbortSignal.any([caller, shutdown.signal]);
    signal.throwIfAborted();
    const grant = await control.begin({ protocolVersion, probeId, executionId, policy });
    if (!grant.dispatchGranted) return;
    const { attempt } = grant;
    if (attempt.probeId !== probeId || attempt.executionId !== executionId || attempt.status !== 'started'
      || attempt.receipt !== null || !isDeepStrictEqual(policy, attempt.policy)) throw new Error('Invalid probe grant');
    let evidence: Pick<OperatorProbeFinalizeInput, 'outcome' | 'usage'> = { outcome: 'unknown', usage: null };
    let providerLogId: string | undefined;
    try {
      signal.throwIfAborted();
      const response = await fetchFn(url, { method: 'POST', headers, body: operatorProbeBody(model),
        signal: AbortSignal.any([signal, AbortSignal.timeout(18_000)]), redirect: 'error' });
      const logId = response.headers.get('cf-aig-log-id');
      if (logId && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(logId)) providerLogId = logId;
      evidence = await operatorProbeEvidence(model, response);
    } catch (error: unknown) {
      console.warn('[operator-probe] Missing upstream evidence', { errorName: error instanceof SyntaxError ? 'SyntaxError' : 'Unavailable' });
    }
    // An independent control deadline preserves known expense after caller disconnect.
    await control.finalize({ protocolVersion, probeId, executionId, economicHash: attempt.economicHash,
      ...evidence, providerReferenceHash, ...(providerLogId ? { providerLogId } : {}) });
  }
  return {
    async run(input: z.infer<typeof OperatorProbeRequestSchema>, signal: AbortSignal) {
      if (shutdown.signal.aborted || active.size >= Math.min(64, config.globalConcurrency)) throw new Error('Probe unavailable');
      const work = execute(input, signal);
      active.add(work);
      try { await work; } finally { active.delete(work); }
    },
    close(signal: AbortSignal) {
      shutdown.abort();
      return waitForRelayWork(Promise.allSettled([...active]), signal);
    },
  };
}
