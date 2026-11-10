import { describe, expect, it, vi } from 'vitest';
import { createOperatorProbeBudgetApp } from '../../packages/platform/src/operator-probe-budget/routes.js';
import { readOperatorProbeAuthorityConfig } from '../../packages/platform/src/operator-probe-budget/main.js';
import { beginInput } from './operator-probe-budget-fixture.js';
const token = 't'.repeat(32);
function fixture() {
  const store = { begin: vi.fn(async () => ({ dispatchGranted: false })), finalize: vi.fn(), getAttempt: vi.fn(), getStatus: vi.fn(async () => null) };
  return { store, app: createOperatorProbeBudgetApp({ token, store }) };
}
const base = '/ai/operator-probe-budget';
const walletBinding = 'e'.repeat(64);
const wire = (operation: unknown) => JSON.stringify({ walletBinding, operation });
describe('operator-only bounded authority', () => {
  it('rejects missing, malformed, browser and unrelated service authentication before store access', async () => {
    const { app, store } = fixture();
    for (const authorization of ['', 'Bearer browser-token', `bearer ${token}`, `Bearer ${token}x`]) {
      expect((await app.request(`${base}/begin`, { method: 'POST', headers: { authorization }, body: wire(beginInput()) })).status).toBe(401);
    }
    expect(store.begin).not.toHaveBeenCalled();
  });
  it('rejects unknown fields, invalid ranges, bad JSON, URL wallet override and >16KiB before store access', async () => {
    const { app, store } = fixture();
    for (const body of ['{', JSON.stringify({ ...beginInput(), budgetId: 'caller' }), JSON.stringify({ ...beginInput(), protocolVersion: 2 })]) {
      expect((await app.request(`${base}/begin`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body })).status).toBe(400);
    }
    expect((await app.request(`${base}/begin?budgetId=caller`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: wire(beginInput()) })).status).toBe(400);
    expect((await app.request(`${base}/begin`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'x'.repeat(16_385) })).status).toBe(413);
    expect(store.begin).not.toHaveBeenCalled();
  });
  it('authenticates every endpoint and maps failures to generic responses', async () => {
    const { app, store } = fixture();
    for (const [path, method] of [['status', 'GET'], ['attempt', 'POST'], ['finalize', 'POST']]) {
      expect((await app.request(`${base}/${path}`, { method })).status).toBe(401);
    }
    const error = new Error('secret provider database path');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.begin.mockRejectedValueOnce(error);
    try {
      const result = await app.request(`${base}/begin`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: wire(beginInput()) });
      expect(result.status).toBe(503); expect(await result.text()).not.toContain('secret');
      expect((await app.request(`${base}/status`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
      expect(log.mock.calls).toEqual([['[operator-probe-budget] Authority request failed']]);
    } finally { log.mockRestore(); }
  });
  it('bounds and strictly validates both monetary callbacks and lookup before invoking the store', async () => {
    const { app, store } = fixture();
    for (const route of ['begin', 'finalize', 'attempt']) {
      for (const [body, status] of [[JSON.stringify({ probeId: beginInput().probeId, unexpected: true }), 400], ['x'.repeat(16_385), 413]] as const) {
        const response = await app.request(`${base}/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
        expect(response.status).toBe(status);
      }
    }
    expect(store.begin).not.toHaveBeenCalled(); expect(store.finalize).not.toHaveBeenCalled(); expect(store.getAttempt).not.toHaveBeenCalled();
    const input = beginInput();
    expect((await app.request(`${base}/begin`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: wire(input) })).status).toBe(200);
    expect(store.begin).toHaveBeenCalledWith(input, walletBinding);
  });
  it('requires a dedicated PG URL, strong service token, budget and literal loopback bind', () => {
    const env = { MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_DATABASE_URL: 'postgresql://localhost/synthetic_test',
      MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN: token, MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID: 'synthetic' };
    expect(readOperatorProbeAuthorityConfig(env)).toMatchObject({ hostname: '127.0.0.1', budgetId: 'synthetic' });
    for (const hostname of ['0.0.0.0', 'localhost', 'example.com']) {
      expect(() => readOperatorProbeAuthorityConfig({ ...env, MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_HOST: hostname })).toThrow();
    }
    expect(() => readOperatorProbeAuthorityConfig({ ...env, MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN: 'short' })).toThrow();
    expect(() => readOperatorProbeAuthorityConfig({ ...env, MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_DATABASE_URL: undefined, DATABASE_URL: env.MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_DATABASE_URL })).toThrow();
  });
});

it('requires the configured wallet precondition for a remote mutation and rejects old authorities before admission', async () => {
  const { createHash } = await import('node:crypto');
  const { configureOperatorProbes } = await import('../../packages/platform/src/operator-probe-budget/adapter.js');
  const { OperatorProbeBeginSchema } = await import('../../packages/contracts/src/funded-operator-probe.js');
  const budgetId = 'synthetic';
  const { store } = fixture();
  const app = createOperatorProbeBudgetApp({ token, store, budgetId });
  const admission = beginInput(), etag = '"' + createHash('sha256').update(budgetId).digest('hex') + '"';
  const req = (expected: string, body: unknown) => app.request(base + '/begin', { method: 'POST', headers: {
    authorization: 'Bearer ' + token, 'if-match': expected }, body: JSON.stringify(body) });
  expect((await req('"wrong"', { operation: admission, walletBinding })).status).toBe(412);
  expect((await req(etag, { operation: admission, walletBinding })).status).toBe(200);
  expect(store.begin).toHaveBeenCalledExactlyOnceWith(admission, walletBinding);
  const oldAuthority = vi.fn<typeof fetch>(async () => {
    return Response.json({}, { status: 400 });
  });
  const remote = configureOperatorProbes({ MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID: budgetId,
    MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN: token, MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_URL: 'https://example.test',
    MATRIX_FUNDED_AI_OPERATOR_PROBE_RELAY_URL: 'http://127.0.0.1:1234' }, '', 'r'.repeat(32), oldAuthority)!;
  await expect(remote.store.begin(admission, walletBinding)).rejects.toThrow();
  expect(oldAuthority).toHaveBeenCalledTimes(1);
  // Task 1 accepts only a strict Begin payload and ignores unknown headers.
  const legacyPayload = JSON.parse(String(oldAuthority.mock.calls[0][1]?.body));
  expect(legacyPayload).toEqual({ operation: admission, walletBinding });
  const { z } = await import('zod/v4');
  expect(z.strictObject({ operation: OperatorProbeBeginSchema }).safeParse(legacyPayload).success).toBe(false);
  for (const legacy of [admission, { operation: admission }]) expect((await req(etag, legacy)).status).toBe(400);
  expect(OperatorProbeBeginSchema.safeParse(legacyPayload).success).toBe(false);
  await remote.close();
});
