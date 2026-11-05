import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFundedRelayService } from '../../packages/proxy/src/funded-main-app.js';
import { glm, headers, model, relayConfig } from './operator-probe-fixture.js';
const now = () => new Date('2026-11-06T00:00:00.000Z');
const config = relayConfig(now());
describe('operator probe protocol', () => {
  it('rejects legacy GET, wrong version/auth and caller-specified limits before the first fetch', async () => {
    const network = vi.fn<typeof fetch>(async () => Response.json({}));
    const service = createFundedRelayService(config, { fetchFn: network, now });
    try {
      expect((await service.app.request('/ready?model=' + model, { headers })).status).toBe(405);
      const probe = { protocolVersion: 1, model, probeId: randomUUID() };
      for (const body of [{ ...probe, protocolVersion: 0 }, { ...probe, max_tokens: 100 }]) {
        expect((await service.app.request('/ready', { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(400);
      }
      expect((await service.app.request('/ready', { method: 'POST', body: JSON.stringify(probe) })).status).toBe(401);
      expect(network).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });
  it('quotes the full catalog context with the existing worst-case estimator', async () => {
    const { operatorProbePolicy } = await import('../../packages/proxy/src/operator-probe-price.js');
    expect(operatorProbePolicy(model, now(), config.pricingReviews).maximumCostMicrousd).toBe(4_800_012);
    expect(operatorProbePolicy(glm, now(), config.pricingReviews).maximumCostMicrousd).toBe(235_931);
    expect(() => operatorProbePolicy(model, new Date('2026-12-01'), config.pricingReviews)).toThrow();
  });
});

describe('terminal billing evidence', () => {
  const usage = { input_tokens: 8, output_tokens: 1, cache_read_input_tokens: 2,
    cache_creation_input_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 } };
  const sonnet = { type: 'message', model: 'claude-sonnet-5', usage, content: [] };
  it('preserves exact normalized cost on unhealthy terminal outcomes and evidence of over-bound counts', async () => {
    const { operatorProbeEvidence } = await import('../../packages/proxy/src/operator-probe-usage.js');
    expect(await operatorProbeEvidence(model, Response.json({ ...sonnet, stop_reason: 'refusal' }))).toEqual({
      outcome: 'not_ready', usage: { inputTokens: 8, outputTokens: 1, cacheReadTokens: 2, cacheWrite5mTokens: 1, cacheWrite1hTokens: 3 },
    });
    for (const reason of [null, 'unrecognized']) {
      expect((await operatorProbeEvidence(model, Response.json({ ...sonnet, stop_reason: reason }))).outcome).toBe('unknown');
    }
    expect((await operatorProbeEvidence(model, Response.json({ ...sonnet, usage: { ...usage, input_tokens: 12_000_000 } }))).usage?.inputTokens).toBe(12_000_000);
    for (const invalid of [{ ...sonnet, usage: {} }, { ...sonnet, model: glm }, { ...sonnet, usage: { ...usage, cache_creation: undefined } }]) {
      await expect(operatorProbeEvidence(model, Response.json(invalid))).rejects.toThrow();
    }
    await expect(operatorProbeEvidence(model, Response.json({ ...sonnet, content: ['x'.repeat(65536)] }))).rejects.toThrow();
  });
  it('requires consistent Workers aggregate usage, model, envelope and terminal choice', async () => {
    const { operatorProbeEvidence } = await import('../../packages/proxy/src/operator-probe-usage.js');
    const choice = { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' };
    const aggregate = { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens: 1, total_tokens: 11 };
    const result = { model: glm, choices: [choice], usage: aggregate };
    expect(await operatorProbeEvidence(glm, Response.json({ success: true, result }))).toEqual({
      outcome: 'ready', usage: { inputTokens: 8, outputTokens: 1, cacheReadTokens: 2, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 } });
    for (const invalid of [{ ...result, success: false }, { ...result, model }, { ...result, usage: { ...aggregate, total_tokens: 1 } }]) {
      await expect(operatorProbeEvidence(glm, Response.json(invalid))).rejects.toThrow();
    }
    expect((await operatorProbeEvidence(glm, Response.json({ ...result, choices: [{ ...choice, finish_reason: null }] }))).outcome).toBe('unknown');
    expect((await operatorProbeEvidence(glm, Response.json({ ...result, choices: [{ ...choice, finish_reason: 'content_filter' }] }))).outcome).toBe('not_ready');
  });
});
