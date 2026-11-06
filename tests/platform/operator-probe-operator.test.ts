import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FUNDED_SONNET } from '../../packages/proxy/src/funded-relay-readiness.js';
import { FUNDED_PRICING_VERSIONS } from '../../packages/proxy/src/funded-pricing-review.js';
import { operatorProbePolicy } from '../../packages/proxy/src/operator-probe-price.js';
import { readFundedPricingReviews } from '../../packages/proxy/src/funded-pricing-review.js';
import { planWallet, doctor, readPrivateJson } from '../../scripts/operator-probe-wallet.js';

export const now = new Date('2026-11-06T00:00:00Z');
const expiresAt = '2026-11-12T00:00:00.000Z';
export const plan = { budgetId: 'synthetic', source: 'reviewed-revision', revision: 'v1',
  allocationMicrousd: 6250000, historicalReserveMicrousd: 1000000, historicalUnpriced: true, expiresAt,
  models: [FUNDED_SONNET], pricingEnv: { MATRIX_FUNDED_SONNET_PRICING_REVIEW_VERSION: FUNDED_PRICING_VERSIONS[FUNDED_SONNET],
    MATRIX_FUNDED_SONNET_PRICING_REVIEWED_AT: '2026-11-01T00:00:00.000Z', MATRIX_FUNDED_SONNET_PRICING_VALID_THROUGH: expiresAt } };
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });
describe('operator-only budget runbook', () => {
  it('rejects broadened allocation, forgotten historical liability, wrong target, and unreviewed models', () => {
    const build = (changes: object) => planWallet({ ...plan, ...changes }, plan.budgetId, now);
    expect(build({}).policies).toEqual([operatorProbePolicy(FUNDED_SONNET, now, readFundedPricingReviews(plan.pricingEnv))]);
    for (const changes of [{ allocationMicrousd: 6250001 }, { historicalUnpriced: false }, { historicalReserveMicrousd: 0 },
      { budgetId: 'other' }, { models: ['unknown'] }, { pricingEnv: {} }, { expiresAt: '2027-01-01T00:00:00.000Z' }])
      expect(() => build(changes)).toThrow();
  });
  it('rejects unsafe config paths before decoding their contents', async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'operator-probe-cli-')));
    const path = join(dir, 'key.json'); await writeFile(path, '{"data":"synthetic"}', { mode: 0o600 });
    expect(await readPrivateJson(path)).toEqual({ data: 'synthetic' });
    const link = join(dir, 'alias'); await symlink(path, link);
    await expect(readPrivateJson(link)).rejects.toThrow();
    await chmod(path, 0o644); await expect(readPrivateJson(path)).rejects.toThrow();
    await chmod(path, 0o600); await chmod(dir, 0o755); await expect(readPrivateJson(path)).rejects.toThrow();
  });
  it('only reads authenticated status and rejects a valid but different wallet instance', async () => {
    const config = { authorityUrl: 'http://127.0.0.1:2345', token: 'synthetic'.repeat(4), budgetId: plan.budgetId, expectedBinding: 'a'.repeat(64) };
    const wallet = { ...planWallet(plan, plan.budgetId, now), walletBinding: config.expectedBinding, heldMicrousd: 0,
      settledMicrousd: 0, frozen: false, attemptCount: 0, availableMicrousd: 5250000 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(wallet))
      .mockResolvedValueOnce(Response.json({ ...wallet, walletBinding: 'b'.repeat(64) })).mockResolvedValueOnce(Response.json(null));
    const receipt = await doctor(config, fetcher);
    expect(receipt).toMatchObject({ walletBinding: config.expectedBinding, historicalCostMicrousd: null, prospectiveSettledMicrousd: 0, availableMicrousd: 5250000 });
    expect(JSON.stringify(receipt)).not.toContain(config.token);
    await expect(doctor(config, fetcher)).rejects.toThrow(); await expect(doctor(config, fetcher)).rejects.toThrow();
    expect(fetcher.mock.calls.every(([url, init]) => url === config.authorityUrl + '/ai/operator-probe-budget/status'
      && init?.method === 'GET' && init.body === undefined && init.redirect === 'error')).toBe(true);
  });
});
