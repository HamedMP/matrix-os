import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { gmailPostgresFiles, prepareGmailPostgres, runGmailPostgres } from '../../scripts/ci/gmail-postgres.mjs';

describe('Gmail PostgreSQL CI qualification', () => {
  it('includes actual driver lifetime and qualified platform/proxy races', () => {
    const files = gmailPostgresFiles(process.cwd());
    for (const file of ['tests/gateway/google-data/provenance/model-history-read-scope.test.ts',
      'tests/gateway/google-data/provenance/model-history-reader-lifecycle.test.ts',
      'tests/platform/ai-funded-qualified-proxy-composition.test.ts',
      'tests/gateway/google-context-admission-startup.test.ts',
      'tests/gateway/google-platform-policy-composition.test.ts',
      'tests/gateway/google-managed-profile-resolution.test.ts',
      'tests/gateway/google-pilot-copy-lifecycle.test.ts',
      'tests/gateway/google-pilot-owner-pool.test.ts',
      'tests/platform/google-qualified-startup.test.ts',
      'tests/platform/account-deletion-google-cleanup.test.ts']) expect(files).toContain(file);
    expect(new Set(files).size).toBe(files.length);
  });
  it('uses only the existing disposable service, prepares once, and adds an enforced runner step', () => {
    const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['funded-postgres'];
    expect(job.steps.some((step: { run?: string }) => step.run === 'node scripts/ci/gmail-postgres.mjs')).toBe(true);
    expect(job.steps.filter((step: { run?: string }) => step.run === 'bun run test:prepare')).toHaveLength(1);
    expect(JSON.stringify(job.env)).not.toContain('secrets.');
    expect(job.env.MATRIX_TEST_POSTGRES_URL).toBe('postgresql://matrix_test:matrix_test@127.0.0.1:5432/matrix_test');
  });
  it.each([undefined, 'postgresql://user:secret@production.invalid/matrix_test', 'postgresql://user:secret@localhost/matrix_test', 'postgresql://user:secret@127.0.0.1/customer'])('rejects unavailable or non-disposable database configuration', url => {
    expect(() => runGmailPostgres(process.cwd(), { MATRIX_TEST_POSTGRES_URL: url })).toThrow('Disposable PostgreSQL');
  });
  it('requires fresh exact-file results with every assertion passed', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'matrix-gmail-ci-'));
    const files = gmailPostgresFiles(process.cwd());
    const env = { MATRIX_TEST_POSTGRES_URL: 'postgresql://user:synthetic@127.0.0.1/matrix_test' };
    const invoke = (mode: 'pass' | 'skip' | 'missing' | 'stale') => (_command: string, args: string[], options: { env: Record<string, string> }) => {
      expect(options.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL).toBe('postgresql://user:synthetic@127.0.0.1/matrix_ci_platform_fixture_admin');
      expect(args).toContain('--no-file-parallelism');
      expect(args).toContain('--maxWorkers=1');
      const report = args.find(value => value.startsWith('--outputFile.json='))!.slice('--outputFile.json='.length);
      if (mode !== 'stale') writeFileSync(report, JSON.stringify({ success: true, numTotalTests: files.length,
        numPassedTests: files.length, numFailedTests: 0, numPendingTests: mode === 'skip' ? 1 : 0,
        testResults: (mode === 'missing' ? files.slice(1) : files).map(file => ({ name: path.join(process.cwd(), file), assertionResults: [{ status: 'passed' }] })) }));
      return { status: 0, signal: null, error: undefined };
    };
    try {
      expect(runGmailPostgres(process.cwd(), env, invoke('pass'), output).assertions).toBe(files.length);
      expect(() => runGmailPostgres(process.cwd(), env, invoke('skip'), output)).toThrow();
      expect(() => runGmailPostgres(process.cwd(), env, invoke('missing'), output)).toThrow();
      expect(() => runGmailPostgres(process.cwd(), env, invoke('stale'), output)).toThrow();
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
  it('prepares only the fixed native fixture admin and closes its owned connection on failure', async () => {
    const queries: string[] = []; let closed = false;
    const env = { MATRIX_TEST_POSTGRES_URL: 'postgresql://user:synthetic@127.0.0.1/matrix_test' };
    await expect(prepareGmailPostgres(env, () => ({ async connect() {}, async query(statement: string) {
      queries.push(statement); if (statement.startsWith('CREATE')) throw Error('synthetic failure'); return { rows: [] };
    }, async end() { closed = true; } }))).rejects.toThrow('synthetic failure');
    expect(closed).toBe(true);
    expect(queries).toContain('CREATE DATABASE matrix_ci_platform_fixture_admin');
    expect(queries.every(query => !query.includes('DROP DATABASE'))).toBe(true);
  });
});
