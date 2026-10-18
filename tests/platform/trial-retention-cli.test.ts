import { afterEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTrialCleanupArguments, claimTrialCleanupJournal } from '../../scripts/ops/cleanup-expired-trials.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('expired trial operator CLI', () => {
  it('uses bounded read-only inventory or an explicit private exact-target review', () => {
    expect(parseTrialCleanupArguments(['--inventory'])).toEqual({ mode: 'inventory' });
    expect(parseTrialCleanupArguments(['/private/review.json'])).toEqual({ mode: 'dry-run', file: '/private/review.json' });
    const fingerprint = 'a'.repeat(64);
    expect(parseTrialCleanupArguments(['/private/review.json', '--apply', '--reviewed-sha256', fingerprint, '--journal', '/private/new-journal.jsonl']))
      .toEqual({ mode: 'apply', file: '/private/review.json', reviewedFingerprint: fingerprint, journal: '/private/new-journal.jsonl' });
  });
  it.each([[], ['--apply'], ['--inventory', '--apply'], ['/private/review.json', '--apply'],
    ['/private/review.json', '--apply', '--reviewed-sha256', 'bad', '--journal', '/private/new.jsonl']].map(args => ({ args })))
    ('refuses ambiguous/destructive arguments $args', ({ args }) => expect(() => parseTrialCleanupArguments(args)).toThrow(/Usage/));
  it('durably claims a new protected journal and appends one matching committed receipt', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'matrix-trial-retention-')));
    directories.push(directory); await chmod(directory, 0o700);
    const path = `${directory}/cleanup.jsonl`; const fingerprint = 'a'.repeat(64); const sourceSha = 'b'.repeat(40);
    const journal = await claimTrialCleanupJournal(path, fingerprint, sourceSha);
    try {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse((await readFile(path, 'utf8')).trim())).toEqual({ status: 'pending', fingerprint, sourceSha });
      await expect(claimTrialCleanupJournal(path, fingerprint, sourceSha)).rejects.toThrow();
      await expect(journal.complete({ mode: 'queued', fingerprint: 'c'.repeat(64), targetCount: 1 })).rejects.toThrow(/mismatch/);
      await journal.complete({ mode: 'queued', fingerprint, targetCount: 1 });
      expect((await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([
        { status: 'pending', fingerprint, sourceSha }, { status: 'queued', result: { mode: 'queued', fingerprint, targetCount: 1 } },
      ]);
      await expect(journal.complete({ mode: 'queued', fingerprint, targetCount: 1 })).rejects.toThrow(/mismatch/);
    } finally { await journal.close(); }
  });
});
