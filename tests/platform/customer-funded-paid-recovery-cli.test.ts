import { existsSync } from 'node:fs';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { at, review, sourceSha, type Review } from './paid-starter-recovery-fixture.js';

interface Cli {
  parsePaidStarterRecoveryArguments(args: string[]): { file: string; apply: boolean; reviewedFingerprint?: string; journal?: string };
  readPaidStarterRecoveryReview(path: string): Promise<Review>;
  claimPaidStarterRecoveryJournal(path: string, fingerprint: string): Promise<{
    complete(result: { mode: 'applied'; fingerprint: string; targetCount: number; grantedMicrousd: number }): Promise<void>;
  }>;
  openPaidStarterRecoveryDatabase(connectionString: string, apply: boolean,
    createPool: (config: pg.PoolConfig) => pg.Pool): PlatformDB;
}
const fixture = () => review([{ ownerId: 'fixture_owner', machineId: '00000000-0000-4000-8000-000000000001',
  runtimeSlot: 'primary', expectedRuntimeTokenEpoch: 1, expectedImageVersion: 'fixture-db-version',
  expectedSubscriptionId: 'sub_fixture', expectedSubscriptionUpdatedAt: at }]);

describe('protected exact-cohort starter recovery CLI', () => {
  let cli: Cli; let directory: string;
  beforeAll(async () => {
    const url = new URL('../../scripts/ops/recover-paid-starter-credit.ts', import.meta.url);
    expect(existsSync(url), 'The reviewed recovery CLI must exist without running on import').toBe(true);
    cli = await import(url.href) as Cli;
  });
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'paid-starter-review-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  it('defaults to dry-run and requires both exact review hash and exclusive journal for apply', () => {
    expect(cli.parsePaidStarterRecoveryArguments(['review.json'])).toEqual({ file: 'review.json', apply: false });
    expect(cli.parsePaidStarterRecoveryArguments(['review.json', '--apply', '--reviewed-sha256', 'a'.repeat(64),
      '--journal', 'private-result.json'])).toMatchObject({ apply: true, reviewedFingerprint: 'a'.repeat(64), journal: 'private-result.json' });
    for (const args of [[], ['review.json', '--apply'], ['review.json', '--apply', '--reviewed-sha256', 'a'.repeat(64)],
      ['review.json', '--force'], ['review.json', '--apply', '--reviewed-sha256', 'bad', '--journal', 'out'],
      ['review.json', '--apply', '--apply', '--journal', 'out'], ['review.json', '--journal', 'out']]) {
      expect(() => cli.parsePaidStarterRecoveryArguments(args)).toThrow();
    }
  });
  it('reads a bounded owner-only exact review, with source and no customer constants in code', async () => {
    const path = join(directory, 'review.json'); await writeFile(path, JSON.stringify(fixture()), { flag: 'wx', mode: 0o600 });
    expect(await cli.readPaidStarterRecoveryReview(path)).toEqual(fixture());
    expect((await cli.readPaidStarterRecoveryReview(path)).sourceSha).toBe(sourceSha);
  });
  it('reads an explicit disabled namespace authority tuple without inferring mode from missing configuration', async () => {
    const input: Review = { ...fixture(), accountDeletionMode: 'disabled', disabledDeletionAuthority: {
      servingRevision: 'matrix-platform-fixture-reviewed', imageDigest: `sha256:${'c'.repeat(64)}` } };
    const path = join(directory, 'disabled-review.json');
    await writeFile(path, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
    expect(await cli.readPaidStarterRecoveryReview(path)).toEqual(input);
  });
  it('rejects permissive permissions, final symlink, linked alias, oversized and duplicate-JSON input', async () => {
    const path = join(directory, 'review.json'); await writeFile(path, JSON.stringify(fixture()), { flag: 'wx', mode: 0o644 });
    await expect(cli.readPaidStarterRecoveryReview(path)).rejects.toThrow();
    await chmod(path, 0o600);
    const alias = join(directory, 'alias.json'); await symlink(path, alias);
    await expect(cli.readPaidStarterRecoveryReview(alias)).rejects.toThrow();
    await rm(alias); await link(path, alias);
    await expect(cli.readPaidStarterRecoveryReview(path)).rejects.toThrow();
    await rm(alias); await writeFile(path, ' '.repeat(65537));
    await expect(cli.readPaidStarterRecoveryReview(path)).rejects.toThrow();
    await writeFile(path, '{"version":1,"version":1}');
    await expect(cli.readPaidStarterRecoveryReview(path)).rejects.toThrow();
  });
  it('rejects symlinked ancestors rather than following a private-looking leaf', async () => {
    const path = join(directory, 'review.json'); await writeFile(path, JSON.stringify(fixture()), { flag: 'wx', mode: 0o600 });
    const alias = `${directory}-alias`; await symlink(directory, alias);
    try { await expect(cli.readPaidStarterRecoveryReview(join(alias, 'review.json'))).rejects.toThrow(); }
    finally { await rm(alias); }
  });
  it('claims a durable exclusive pending journal before apply and refuses automatic replay', async () => {
    const path = join(directory, 'result.json'); const fingerprint = 'b'.repeat(64);
    const journal = await cli.claimPaidStarterRecoveryJournal(path, fingerprint);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ status: 'pending', fingerprint });
    await expect(cli.claimPaidStarterRecoveryJournal(path, fingerprint)).rejects.toThrow();
    await journal.complete({ mode: 'applied', fingerprint, targetCount: 3, grantedMicrousd: 15_000_000 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ status: 'applied', fingerprint,
      targetCount: 3, grantedMicrousd: 15_000_000 });
    await expect(cli.claimPaidStarterRecoveryJournal(path, fingerprint)).rejects.toThrow();
  });
  it('does not echo credentials, review contents or private paths in CLI failures', async () => {
    const marker = 'fixture-secret-must-not-print'; const path = join(directory, `${marker}.json`);
    await writeFile(path, `{"version":1,"private":"${marker}"}`, { flag: 'wx', mode: 0o600 });
    try {
      await promisify(execFile)('bun', ['scripts/ops/recover-paid-starter-credit.ts', path],
        { env: { ...process.env, PLATFORM_DATABASE_URL: `postgresql://fixture:${marker}@invalid.example/db` }, timeout: 5000 });
      throw new Error('Malformed reviewed input must fail before connecting');
    } catch (error) {
      expect(error).toMatchObject({ code: 1, stdout: '' });
      expect((error as { stderr: string }).stderr).not.toContain(marker);
      expect((error as { stderr: string }).stderr).not.toContain(directory);
      expect((error as { stderr: string }).stderr).not.toContain('postgresql:');
    }
  });
  it.each([false, true])('creating and awaiting the operator DB handle performs no startup migrations (apply=%s)', async apply => {
    const query = vi.fn(); const connect = vi.fn();
    const pool = { on: vi.fn(), query, connect, ended: false,
      end: vi.fn(async () => { pool.ended = true; }) };
    const createPool = vi.fn(() => pool as unknown as pg.Pool);
    const db = cli.openPaidStarterRecoveryDatabase('postgresql://fixture@127.0.0.1/disposable', apply, createPool);
    try {
      await db.ready;
      expect(query).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
      expect(createPool).toHaveBeenCalledWith(expect.objectContaining({ max: 1, connectionTimeoutMillis: 10_000,
        statement_timeout: 15_000, lock_timeout: 3000,
        options: apply ? undefined : '-c default_transaction_read_only=on' }));
    } finally { await db.destroy(); }
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
  it('rejects unverified remote database URLs before constructing a pool', () => {
    const createPool = vi.fn();
    expect(() => cli.openPaidStarterRecoveryDatabase('postgresql://fixture@remote.invalid/db?sslmode=no-verify', false, createPool)).toThrow();
    expect(createPool).not.toHaveBeenCalled();
  });
});
