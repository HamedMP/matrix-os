import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { sql } from 'kysely';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformDb } from '../../packages/platform/src/db.js';
import { createAiFundedRelayRoutes } from '../../packages/platform/src/ai-funded-policy-routes.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { createFundedModelProbeService } from '../../packages/platform/src/ai-funded-model-probes.js';
import { configureOperatorProbes } from '../../packages/platform/src/operator-probe-budget/adapter.js';
import { createOperatorProbeBudgetApp } from '../../packages/platform/src/operator-probe-budget/routes.js';
import { createOperatorProbeBudgetRepository, initializeOperatorProbeBudget } from '../../packages/platform/src/operator-probe-budget/repository.js';
import { createFundedRelayService } from '../../packages/proxy/src/funded-main-app.js';
import { operatorProbePolicy } from '../../packages/proxy/src/operator-probe-price.js';
import { glm, model, headers, relayConfig, token } from '../proxy/operator-probe-fixture.js';
import { config, postgresFixture } from './operator-probe-budget-fixture.js';

async function listen(app: Hono) {
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const listener = serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch }, () => resolve(listener));
    listener.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { origin: 'http://127.0.0.1:' + address.port, close: () =>
    new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)('monetary protocol through HTTP and PostgreSQL', () => {
  it('shares one local and remote wallet, dispatches one fixed request per grant and reads committed receipts', async () => {
    const fixture = await postgresFixture(), db = createPlatformDb(fixture.databaseUrl);
    const cleanup: (() => Promise<unknown>)[] = [];
    try {
      await db.ready;
      const now = new Date(), authorityToken = 'a'.repeat(32);
      const wallet = createOperatorProbeBudgetRepository({ db: fixture.connect(), budgetId: config.budgetId });
      const authority = await listen(createOperatorProbeBudgetApp({ token: authorityToken, store: wallet, budgetId: config.budgetId }));
      cleanup.push(authority.close);
      const env = { MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID: config.budgetId,
        MATRIX_FUNDED_AI_OPERATOR_PROBE_RELAY_URL: 'http://127.0.0.1:10000' };
      const remoteEnv = { ...env, MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_URL: authority.origin,
        MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN: authorityToken };
      const local = configureOperatorProbes(env, fixture.databaseUrl, token)!;
      const remote = configureOperatorProbes(remoteEnv, fixture.databaseUrl, token)!;
      cleanup.push(local.close, remote.close);
      const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: 'k'.repeat(32) });
      const facade = await listen(new Hono().route('/internal/ai/funded', createAiFundedRelayRoutes({
        repository, relayControlToken: token, operatorStore: remote.store,
      })));
      cleanup.push(facade.close);
      const relay = relayConfig(now, facade.origin);
      const policies = [model, glm].map(id => operatorProbePolicy(id, now, relay.pricingReviews));
      const expiresAt = new Date(+now + 60_000).toISOString();
      await initializeOperatorProbeBudget(fixture.connect(), { ...config, policies, expiresAt });
      for (const [authorization, body, status] of [
        ['Bearer ' + authorityToken, '{}', 401], ['Bearer owner', '{}', 401], [headers.authorization, '{}', 400],
        [headers.authorization, 'x'.repeat(16_385), 413],
      ] as const) {
        const result = await fetch(facade.origin + '/internal/ai/funded/operator-probe/begin', { method: 'POST',
          headers: { authorization }, body, redirect: 'error', signal: AbortSignal.timeout(3000) });
        expect(result.status).toBe(status); await result.body?.cancel();
      }
      expect((await local.store.getStatus())?.attemptCount).toBe(0);
      const providerId = randomUUID();
      const upstream = vi.fn<typeof fetch>(async (url, init) => {
        const h = new Headers(init!.headers);
        expect(h.get('cf-aig-max-attempts')).toBe('1');
        expect(h.get('cf-aig-skip-cache')).toBe('true');
        expect(h.get('cf-aig-collect-log-payload')).toBe('false');
        expect(JSON.parse(h.get('cf-aig-metadata')!).probe_ref).toMatch(/^[a-f0-9]{64}$/);
        const body = JSON.parse(String(init?.body));
        expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
        expect(body.stream).toBe(false);
        expect(body.max_tokens ?? body.max_completion_tokens).toBe(1);
        const result = String(url).endsWith('/v1/messages')
          ? { model: 'claude-sonnet-5', type: 'message', content: [], stop_reason: 'max_tokens', usage: { input_tokens: 6, output_tokens: 1 } }
          : { success: true, result: { model: glm, usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
              choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }] } };
        return Response.json(result, { headers: { 'cf-aig-log-id': providerId } });
      });
      let loseFinalizeAck = true, loseBeginAck = false, dropFinalize = false;
      let pauseFinalize: (() => Promise<void>) | undefined;
      const transport: typeof fetch = async (url, init) => {
        if (String(url).startsWith(facade.origin + '/')) {
          if (String(url).endsWith('/finalize')) {
            if (dropFinalize) throw new Error('Synthetic precommit finalization failure');
            await pauseFinalize?.();
          }
          const response = await fetch(url, init);
          if (String(url).endsWith('/begin') && loseBeginAck) {
            await response.body?.cancel(); throw new Error('Synthetic lost begin acknowledgement');
          }
          if (String(url).endsWith('/finalize') && loseFinalizeAck) {
            loseFinalizeAck = false; await response.body?.cancel(); throw new Error('Synthetic lost acknowledgement');
          }
          return response;
        }
        return upstream(url, init);
      };
      const replicas = [createFundedRelayService(relay, { fetchFn: transport }), createFundedRelayService(relay, { fetchFn: transport })];
      cleanup.push(...replicas.map(r => () => r.close()));
      const listeners = await Promise.all(replicas.map(r => listen(r.app)));
      cleanup.push(...listeners.map(s => s.close));
      const source = configureOperatorProbes({ ...remoteEnv, MATRIX_FUNDED_AI_OPERATOR_PROBE_RELAY_URL: listeners[0].origin }, fixture.databaseUrl, token)!;
      cleanup.push(source.close);
      const platformFetch = vi.fn<typeof fetch>((url, init) => {
        if (!String(url).startsWith(listeners[0].origin + '/')) throw new Error('Unexpected ordinary inference Relay');
        return fetch(url, init);
      });
      const platform = createFundedModelProbeService({ db, relayBaseUrl: 'https://old-chat.invalid', relayControlToken: token,
        dailyLimit: 30, minuteLimit: 12, operator: source, fetchFn: platformFetch });
      expect((await platform.readCached!(model)).ready).toBe(false);
      const health = await platform.probe(model);
      expect(health.ready).toBe(true);
      expect(Date.parse(health.staleAfter)).toBeLessThanOrEqual(Date.parse(expiresAt));
      expect((await platform.readCached!(model)).ready).toBe(true);
      expect(platformFetch).toHaveBeenCalledTimes(1);
      const begin = JSON.parse(String(platformFetch.mock.calls[0][1]!.body));
      const settled = await local.store.getAttempt(begin.probeId);
      expect(settled?.receipt).toMatchObject({ providerLogId: providerId, status: 'settled', costMicrousd: 22,
        providerReferenceHash: JSON.parse(new Headers(upstream.mock.calls[0][1]!.headers).get('cf-aig-metadata')!).probe_ref });
      const walletBinding = (await local.store.getStatus())!.walletBinding;
      const probeId = randomUUID(), body = JSON.stringify({ model: glm, protocolVersion: 1, probeId, walletBinding });
      const replay = () => Promise.all(listeners.map(s => fetch(s.origin + '/ready', { method: 'POST', headers, body,
        signal: AbortSignal.timeout(5000), redirect: 'error' })));
      expect((await replay()).map(r => r.status)).toEqual([204, 204]);
      expect((await replay()).map(r => r.status)).toEqual([204, 204]);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect((await remote.store.getAttempt(probeId))?.receipt).toMatchObject({ status: 'settled', outcome: 'ready', costMicrousd: 2 });
      expect(await local.store.getStatus()).toMatchObject({ attemptCount: 2, heldMicrousd: 0, settledMicrousd: 24 });
      // No-receipt legacy response and rotated authority/policy cannot reuse priced health.
      const rotated = configureOperatorProbes({ ...env, MATRIX_FUNDED_AI_OPERATOR_PROBE_RELAY_URL: listeners[0].origin }, fixture.databaseUrl, token)!;
      cleanup.push(rotated.close);
      const old = vi.fn<typeof fetch>(async () => Response.json({ ready: true, priceValidThrough: expiresAt }));
      const isolated = createFundedModelProbeService({ db, operator: rotated, dailyLimit: 30, minuteLimit: 12, relayControlToken: token, fetchFn: old });
      expect((await isolated.readCached!(model)).ready).toBe(false);
      expect((await isolated.probe(model)).ready).toBe(false);
      expect(old.mock.calls.map(call => [call[0], call[1]?.method])).toEqual([[listeners[0].origin + '/ready', 'POST']]);
      expect((await local.store.getStatus())?.attemptCount).toBe(2);
      const updated = { ...config, policies: [{ ...policies[0], pricingVersion: 'future' }, policies[1]], expiresAt };
      await sql`update operator_probe_wallets set config=${JSON.stringify(updated)}::jsonb`.execute(db.executor);
      expect((await platform.readCached!(model)).ready).toBe(false);
      await sql`update operator_probe_wallets set config=${JSON.stringify({ ...config, policies, expiresAt })}::jsonb`.execute(db.executor);

      // Begin committed but its grant was lost. A second replica observes the hold without dispatch.
      async function post(id: string, replica = 0) {
        return fetch(listeners[replica].origin + '/ready', { method: 'POST', headers,
          body: JSON.stringify({ model: glm, protocolVersion: 1, probeId: id, walletBinding }), redirect: 'error', signal: AbortSignal.timeout(6000) });
      }
      const lostGrant = randomUUID(); loseBeginAck = true;
      expect((await post(lostGrant)).status).toBe(503);
      loseBeginAck = false;
      expect((await post(lostGrant, 1)).status).toBe(204);
      expect((await local.store.getAttempt(lostGrant))?.status).toBe('started');
      expect(upstream).toHaveBeenCalledTimes(2);
      const lostReceipt = randomUUID(); dropFinalize = true;
      expect((await post(lostReceipt)).status).toBe(503);
      dropFinalize = false;
      expect((await post(lostReceipt, 1)).status).toBe(204);
      expect((await local.store.getAttempt(lostReceipt))?.status).toBe('started');
      expect(upstream).toHaveBeenCalledTimes(3);
      expect((await local.store.getStatus())?.heldMicrousd).toBe(2 * policies[1].maximumCostMicrousd);

      // Finalization remains owned after caller cancellation. Shutdown closes admission and drains it.
      const finalizing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      pauseFinalize = () => { finalizing.resolve(); return release.promise; };
      const client = new AbortController(), finalId = randomUUID();
      const pending = replicas[0].app.request('/ready', { method: 'POST', headers, signal: client.signal,
        body: JSON.stringify({ model: glm, protocolVersion: 1, probeId: finalId, walletBinding }) });
      await finalizing.promise;
      client.abort();
      let drained = false;
      const closing = replicas[0].close().then(result => { drained = true; return result; });
      try {
        expect((await post(randomUUID())).status).toBe(503);
        expect(drained).toBe(false);
      } finally { release.resolve(); }
      expect((await pending).status).toBe(204);
      expect(await closing).toBe(true);
      expect((await local.store.getAttempt(finalId))?.receipt?.costMicrousd).toBe(2);
      expect((await local.store.getStatus())?.heldMicrousd).toBe(2 * policies[1].maximumCostMicrousd);

      // The remaining live replica sees the same lifetime liabilities.
      pauseFinalize = undefined;
      const usage = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 };
      const response = (finish_reason: string, counts: unknown) => Response.json({ success: true, result: {
        model: glm, choices: [{ index: 0, finish_reason, message: { role: 'assistant', content: '' } }], usage: counts,
      } });
      for (const [payload, status] of [[response('content_filter', usage), 'settled'], [Response.json({ success: true, result: { model: glm, choices: [], usage } }), 'unknown'],
        [Response.json({ success: true, result: { model: glm, choices: [], usage: { ...usage, completion_tokens: 2, total_tokens: 7 } } }), 'discrepancy']] as const) {
        upstream.mockResolvedValueOnce(payload);
        const id = randomUUID();
        expect((await post(id, 1)).status).toBe(204);
        const receipt = (await remote.store.getAttempt(id))?.receipt;
        expect(receipt?.status).toBe(status);
        if (status === 'unknown') expect(receipt).toMatchObject({ usage: { outputTokens: 1 }, costMicrousd: null });
        if (status === 'settled') expect(receipt).toMatchObject({ outcome: 'not_ready', costMicrousd: 2 });
      }
      expect(await local.store.getStatus()).toMatchObject({ heldMicrousd: 4 * policies[1].maximumCostMicrousd,
        frozen: true, settledMicrousd: 28 });
      expect((await post(randomUUID(), 1)).status).toBe(503);
      expect(upstream).toHaveBeenCalledTimes(7);
    } finally {
      try { for (const close of cleanup.reverse()) await close(); }
      finally { await db.destroy(); await fixture.destroy(); }
    }
  }, 15_000);
});

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)('origin wallet binding across two paid facades', () => {
  it.each(['different-id', 'same-id'])('prevents a misroute before either wallet grants, including %s placements', async scenario => {
    const fixtures = [await postgresFixture(), await postgresFixture()];
    const dbs = fixtures.map(f => createPlatformDb(f.databaseUrl));
    const cleanup: (() => Promise<unknown>)[] = [];
    try {
      const now = new Date(), cfg = relayConfig(now);
      const policy = operatorProbePolicy(glm, now, cfg.pricingReviews);
      const walletIds = [config.budgetId, scenario === 'same-id' ? config.budgetId : 'other'];
      const facades = [], wallets = [], placements = [];
      for (const [i, db] of dbs.entries()) {
        await db.ready;
        await initializeOperatorProbeBudget(fixtures[i].connect(), { ...config, budgetId: walletIds[i], policies: [policy], expiresAt: policy.pricingValidThrough });
        const authorityToken = 'a'.repeat(32);
        const authority = await listen(createOperatorProbeBudgetApp({ token: authorityToken, budgetId: walletIds[i],
          store: createOperatorProbeBudgetRepository({ db: fixtures[i].connect(), budgetId: walletIds[i] }) }));
        cleanup.push(authority.close);
        // Origin uses a bounded local store; the misconfigured Relay's facade uses its different remote authority.
        const placement = configureOperatorProbes({ MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID: walletIds[i],
          ...(i === 1 ? { MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_URL: authority.origin, MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN: authorityToken } : {}),
          MATRIX_FUNDED_AI_OPERATOR_PROBE_RELAY_URL: 'http://127.0.0.1:9991' }, fixtures[i].databaseUrl, token)!;
        placements.push(placement); wallets.push(placement.store); cleanup.push(placement.close);
        const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: 'k'.repeat(32) });
        const facade = await listen(new Hono().route('/internal/ai/funded', createAiFundedRelayRoutes({
          repository, relayControlToken: token, operatorStore: placement.store })));
        facades.push(facade); cleanup.push(facade.close);
      }
      const paid = vi.fn(async () => Response.json({ success: true, result: { model: glm,
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }, choices: [{ index: 0,
          finish_reason: 'length', message: { role: 'assistant', content: '' } }] } }));
      const listeners = [];
      for (const facade of facades) {
        const relay = createFundedRelayService(relayConfig(now, facade.origin), { fetchFn: async (url, init) =>
          String(url).startsWith(facade.origin + '/') ? fetch(url, init) : paid() });
        const listener = await listen(relay.app); listeners.push(listener); cleanup.push(() => relay.close(), listener.close);
      }
      const transport = vi.fn<typeof fetch>((url, init) => fetch(url, init));
      const probes = createFundedModelProbeService({ db: dbs[0], operator: { ...placements[0], relayOrigin: listeners[1].origin },
        dailyLimit: 50, minuteLimit: 20, fetchFn: transport, relayControlToken: token });
      expect((await probes.probe(glm)).ready).toBe(false);
      expect(paid).not.toHaveBeenCalled();
      for (const wallet of wallets) expect(await wallet.getStatus()).toMatchObject({ attemptCount: 0, heldMicrousd: 0, settledMicrousd: 0 });
      const body = String(transport.mock.calls[0][1]!.body);
      const originBinding = (await wallets[0].getStatus())!.walletBinding;
      expect(JSON.parse(body).walletBinding).toBe(originBinding);
      const { OperatorProbeRequestSchema } = await import('../../packages/contracts/src/funded-operator-probe.js');
      expect(OperatorProbeRequestSchema.omit({ walletBinding: true }).safeParse(JSON.parse(body)).success).toBe(false);
      expect((await wallets[1].getStatus())!.walletBinding).not.toBe(originBinding);
      for (let i = 0; i < 2; i++) {
        const response = await fetch(listeners[0].origin + '/ready', { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(5000) });
        expect(response.status).toBe(204);
      }
      expect(paid).toHaveBeenCalledTimes(1);
      expect(await wallets[0].getStatus()).toMatchObject({ attemptCount: 1, heldMicrousd: 0, settledMicrousd: 2 });
    } finally {
      for (const close of cleanup.reverse()) await close();
      await Promise.all(dbs.map(db => db.destroy())); await Promise.all(fixtures.map(f => f.destroy()));
    }
  }, 15_000);
});

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)('Platform probe shutdown', () => {
  it('keeps the actual callback transport live through finalization and denies new grants before closing it', async () => {
    const { closePlatformProbeTransport } = await import('../../packages/platform/src/operator-probe-budget/shutdown.js');
    const f = await postgresFixture(), db = createPlatformDb(f.databaseUrl);
    const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const cleanup: (() => Promise<unknown>)[] = [];
    try {
      await db.ready;
      const now = new Date(), policy = operatorProbePolicy(glm, now, relayConfig(now).pricingReviews);
      await initializeOperatorProbeBudget(f.connect(), { ...config, policies: [policy], expiresAt: policy.pricingValidThrough });
      const placement = configureOperatorProbes({ MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID: config.budgetId,
        MATRIX_FUNDED_AI_OPERATOR_PROBE_RELAY_URL: 'http://127.0.0.1:1' }, f.databaseUrl, token)!;
      cleanup.push(placement.close);
      const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: 'k'.repeat(32) });
      const facade = await listen(new Hono().route('/internal/ai/funded', createAiFundedRelayRoutes({ repository, relayControlToken: token, operatorStore: placement.store })));
      let closing: Promise<void> | undefined;
      const closeFacade = () => closing ??= facade.close();
      cleanup.push(closeFacade);
      const relay = createFundedRelayService(relayConfig(now, facade.origin), { fetchFn: async (url, init) => {
        if (String(url).startsWith(facade.origin + '/')) {
          if (String(url).endsWith('/finalize')) { entered.resolve(); await release.promise; }
          return fetch(url, init);
        }
        return Response.json({ success: true, result: { model: glm, choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } } });
      } });
      const listener = await listen(relay.app); cleanup.push(() => relay.close(), listener.close);
      const probes = createFundedModelProbeService({ db, operator: { ...placement, relayOrigin: listener.origin },
        dailyLimit: 30, minuteLimit: 10, relayControlToken: token });
      const pending = probes.probe(glm);
      await entered.promise;
      const audit = createOperatorProbeBudgetRepository({ db: f.connect(), budgetId: config.budgetId });
      const shut = Promise.withResolvers<void>();
      closePlatformProbeTransport(probes, () => { void closeFacade().then(() => probes.close!()).then(shut.resolve, shut.reject); });
      try {
        expect(closing).toBeUndefined();
        const rejected = await fetch(listener.origin + '/ready', { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ model: glm, protocolVersion: 1, probeId: randomUUID(), walletBinding: (await placement.store.getStatus())!.walletBinding }) });
        expect(rejected.status).toBe(503);
        expect((await probes.probe(model)).ready).toBe(false);
      } finally { release.resolve(); await pending; await shut.promise; }
      expect((await pending).ready).toBe(true);
      expect(await audit.getStatus()).toMatchObject({ heldMicrousd: 0, settledMicrousd: 2, attemptCount: 1 });
      await expect(placement.store.getStatus()).rejects.toThrow();
    } finally {
      release.resolve();
      for (const close of cleanup.reverse()) await close();
      await db.destroy(); await f.destroy();
    }
  }, 15_000);
});
