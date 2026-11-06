import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { runOperatorWallet } from '../../scripts/operator-probe-wallet.js';
import { FUNDED_GLM_FLASH } from '../../packages/proxy/src/funded-relay-model.js';
import { FUNDED_PRICING_VERSIONS } from '../../packages/proxy/src/funded-pricing-review.js';
import { createOperatorProbeBudgetRepository } from '../../packages/platform/src/operator-probe-budget/repository.js';
import { postgresFixture, beginInput } from './operator-probe-budget-fixture.js';

it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)('validates dedicated placement before DDL, verifies forwarded identity and survives explicit bootstrap replay/restart', async () => {
  const fixture = await postgresFixture();
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'operator-cli-pg-')));
  let service: { close(): Promise<void> } | undefined;
  try {
    const db = fixture.connect();
    const expectedSchema = new URL(fixture.databaseUrl).searchParams.get('options')!.split('=')[1]!;
    const u = new URL(fixture.databaseUrl);
    const socket = createServer(); await new Promise<void>(ok => socket.listen(0, '127.0.0.1', ok));
    const address = socket.address(); if (!address || typeof address === 'string') throw new Error('Unavailable port');
    await new Promise<void>((ok, fail) => socket.close(error => error ? fail(error) : ok()));
    const authority = { databaseUrl: fixture.databaseUrl, expectedDatabase: u.pathname.slice(1), expectedRole: u.username,
      expectedSchema, token: 'synthetic'.repeat(4), budgetId: 'synthetic', hostname: '127.0.0.1', port: address.port };
    const now = new Date('2026-11-06T00:00:00Z'), expiresAt = '2026-11-15T00:00:00.000Z';
    const plan = { budgetId: 'synthetic', source: 'synthetic', revision: 'v1', expiresAt,
      models: [FUNDED_GLM_FLASH], allocationMicrousd: 6250000, historicalReserveMicrousd: 1000000, historicalUnpriced: true,
      pricingEnv: { MATRIX_FUNDED_GLM_PRICING_REVIEW_VERSION: FUNDED_PRICING_VERSIONS[FUNDED_GLM_FLASH],
        MATRIX_FUNDED_GLM_PRICING_REVIEWED_AT: '2026-11-01T00:00:00.000Z', MATRIX_FUNDED_GLM_PRICING_VALID_THROUGH: expiresAt } };
    async function file(name: string, data: unknown) {
      const path = join(dir, name); await writeFile(path, JSON.stringify(data), { mode: 0o600 }); return path;
    }
    const cp = await file('authority', authority), pp = await file('plan', plan);
    // An unqualified URL has no explicit search_path. Even with the right db/role, reject
    // the wrong namespace before the authority can run its migration.
    u.search = '';
    const wrong = await file('wrong', { ...authority, expectedSchema: 'wrong', databaseUrl: u.toString() });
    await expect(runOperatorWallet(['serve', wrong])).rejects.toThrow();
    await expect(runOperatorWallet(['inspect', cp])).rejects.toThrow(); // unmigrated; reads do not create tables
    expect((await sql<{ rel: string | null }>`SELECT to_regclass('operator_probe_wallets')::text AS rel`.execute(db)).rows[0]?.rel).toBeNull();
    async function start() {
      const result = await runOperatorWallet(['serve', cp]);
      if (!('server' in result)) throw new Error('Missing service');
      service = result;
    }
    await start();
    expect(await runOperatorWallet(['inspect', cp])).toEqual({ initialized: false });
    const initialized = await runOperatorWallet(['initialize', cp, pp], now);
    if (!('walletBinding' in initialized)) throw new Error('Missing wallet');
    const doctor = await file('doctor', { authorityUrl: 'http://127.0.0.1:' + address.port, token: authority.token,
      budgetId: authority.budgetId, expectedBinding: initialized.walletBinding });
    expect(await runOperatorWallet(['doctor', doctor])).toEqual(initialized);
    const store = createOperatorProbeBudgetRepository({ db, budgetId: 'synthetic', now: () => now });
    const wallet = await store.getStatus(); if (!wallet) throw new Error('Missing wallet');
    await store.begin({ ...beginInput(), policy: wallet.policies[0]! }, wallet.walletBinding);
    const after = await runOperatorWallet(['doctor', doctor]);
    expect(after).toMatchObject({ heldMicrousd: wallet.policies[0]!.maximumCostMicrousd, prospectiveSettledMicrousd: 0, attemptCount: 1 });
    await service!.close(); await start();
    expect(await runOperatorWallet(['initialize', cp, pp], now)).toEqual(after);
    expect(await runOperatorWallet(['doctor', doctor])).toEqual(after);
    const changed = await file('changed-plan', { ...plan, revision: 'changed' });
    await expect(runOperatorWallet(['initialize', cp, changed], now)).rejects.toThrow();
    expect(await runOperatorWallet(['inspect', cp])).toEqual(after);
  } finally {
    try { await service?.close(); } finally { await fixture.destroy(); await rm(dir, { recursive: true, force: true }); }
  }
});
