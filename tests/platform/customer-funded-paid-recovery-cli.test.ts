import { existsSync } from 'node:fs';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { at, review, sourceSha, type Review } from './paid-starter-recovery-fixture.js';

interface Cli {
  parsePaidStarterRecoveryArguments(args: string[]): { file: string; apply: boolean; reviewedFingerprint?: string; journal?: string };
  readPaidStarterRecoveryReview(path: string): Promise<Review>;
  claimPaidStarterRecoveryJournal(path: string, fingerprint: string): Promise<{
    complete(result: { mode: 'applied'; fingerprint: string; targetCount: number; grantedMicrousd: number }): Promise<void>;
  }>;
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
});
