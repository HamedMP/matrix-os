import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { sourceChangeScript } from '../../scripts/ci/dedicated-changes.mjs';
import { isGitAncestor, readGitChangedPaths } from '../../scripts/ci/git-coverage.mjs';

const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
const job = workflow.jobs.changes;
const checkout = job.steps.find((step: { name?: string }) => step.name === 'Checkout with bounded retry');
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temp = () => { const directory = mkdtempSync(join(tmpdir(), 'ci-checkout-')); temporary.push(directory); return directory; };
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
function fixture() {
  const root = temp(), source = join(root, 'source'), target = join(root, 'target');
  mkdirSync(source); mkdirSync(target); mkdirSync(join(root, 'owner'));
  git(source, 'init', '-q'); git(source, 'config', 'user.email', 'ci@example.invalid'); git(source, 'config', 'user.name', 'CI fixture');
  mkdirSync(join(source, 'scripts/ci'), { recursive: true });
  writeFileSync(join(source, 'scripts/ci/helper.mjs'), 'export const version = 1;\n');
  writeFileSync(join(source, 'scripts/ci/os-view-parity-plan.mjs'), readFileSync(join(process.cwd(), 'scripts/ci/os-view-parity-plan.mjs')));
  writeFileSync(join(source, 'historical.bin'), randomBytes(256 * 1024));
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'historical source');
  const base = git(source, 'rev-parse', 'HEAD'), historicalBlob = git(source, 'rev-parse', 'HEAD:historical.bin');
  rmSync(join(source, 'historical.bin')); writeFileSync(join(source, 'unrelated.bin'), randomBytes(256 * 1024));
  writeFileSync(join(source, 'scripts/ci/helper.mjs'), 'export const version = 2;\n');
  git(source, 'add', '-A'); git(source, 'commit', '-qm', 'current source');
  const sha = git(source, 'rev-parse', 'HEAD'), unrelatedBlob = git(source, 'rev-parse', 'HEAD:unrelated.bin');
  git(source, 'update-ref', 'refs/heads/main', base);
  const remote = join(root, 'owner/repo.git');
  git(root, 'clone', '-q', '--bare', source, remote); git(remote, 'config', 'uploadpack.allowFilter', 'true');
  return { root, target, base, sha, historicalBlob, unrelatedBlob };
}
function execute(f: ReturnType<typeof fixture>, overrides: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', checkout.run], {
    cwd: f.target, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ...checkout.env, GH_TOKEN: 'fixture-token', SOURCE_SHA: f.sha,
      GITHUB_SERVER_URL: `file://${f.root}`, GITHUB_REPOSITORY: 'owner/repo',
      CHECKOUT_BACKOFF_SECONDS: '0', ...overrides },
  });
}

describe('change detector checkout', () => {
  it('retains complete ancestry and cumulative path coverage without downloading unrelated blobs', () => {
    const f = fixture(), result = execute(f);
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(git(f.target, 'rev-parse', 'HEAD')).toBe(f.sha);
    expect(git(f.target, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(readFileSync(join(f.target, 'scripts/ci/helper.mjs'), 'utf8')).toContain('version = 2');
    const spawnGit = (command: string, args: string[], options: object) => spawnSync(command, args, { ...options, cwd: f.target });
    expect(isGitAncestor(f.base, f.sha, { spawnGit })).toBe(true);
    expect(readGitChangedPaths(f.base, f.sha, { spawnGit })).toEqual(['historical.bin', 'scripts/ci/helper.mjs', 'unrelated.bin']);
    expect(existsSync(join(f.target, 'unrelated.bin'))).toBe(false);
    const missing = git(f.target, 'rev-list', '--objects', '--all', '--missing=print').split('\n');
    expect(missing).toContain(`?${f.historicalBlob}`); expect(missing).toContain(`?${f.unrelatedBlob}`);
    const config = git(f.target, 'config', '--local', '--list');
    expect(config).not.toContain('fixture-token');
    expect(config).not.toContain('http.extraheader');
    expect(config).not.toContain(Buffer.from('x-access-token:fixture-token').toString('base64'));
  });

  it('runs the actual PR classifier without fetching omitted blobs for rename detection', () => {
    const f = fixture(), checkoutResult = execute(f);
    expect(checkoutResult.status, checkoutResult.stderr).toBe(0);
    const output = join(f.root, 'github-output'); writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', sourceChangeScript], {
      cwd: f.target, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge',
        GITHUB_BASE_REF: 'main', GITHUB_SHA: f.sha, GITHUB_OUTPUT: output,
        PR_DRAFT: 'false', PR_ACTION: 'synchronize', PR_BASE_EDIT: 'false' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('should_run=true');
    const missing = git(f.target, 'rev-list', '--objects', '--all', '--missing=print').split('\n');
    expect(missing).toContain(`?${f.historicalBlob}`); expect(missing).toContain(`?${f.unrelatedBlob}`);
  });

  it('keeps the complete fetch and materialization attempt bounded within the job budget', () => {
    const seconds = Number(checkout.env.CHECKOUT_TIMEOUT_SECONDS), attempts = Number(checkout.env.CHECKOUT_MAX_ATTEMPTS);
    expect(seconds).toBeGreaterThanOrEqual(120); expect(seconds).toBeLessThanOrEqual(180);
    const backoff = Number(checkout.env.CHECKOUT_BACKOFF_SECONDS) * attempts * (attempts - 1) / 2;
    const classifier = readFileSync(join(process.cwd(), 'scripts/ci/dedicated-changes.mjs'), 'utf8');
    const classifierSeconds = Number(classifier.match(/timeout:\s*(\d+)/)?.[1]) / 1000;
    expect(classifierSeconds).toBeGreaterThan(0);
    expect(job['timeout-minutes'] * 60).toBeGreaterThan(attempts * (seconds + 5) + backoff + classifierSeconds + 60);
    expect(checkout.run).toMatch(/timeout[\s\S]*bash -c/);
  });

  it('fails closed after bounded transport failures without checking out a different source', () => {
    const f = fixture(), bin = join(f.root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'timeout'), '#!/bin/sh\necho fixture-transport-timeout >&2\nexit 124\n'); chmodSync(join(bin, 'timeout'), 0o755);
    const result = execute(f, { PATH: `${bin}:${process.env.PATH}` });
    expect(result.status).toBe(1); expect(result.stdout).toContain('failed after 3 attempts');
    expect(result.stderr.match(/fixture-transport-timeout/g)).toHaveLength(3);
    expect(existsSync(join(f.target, 'scripts/ci/helper.mjs'))).toBe(false);
  });

  it('terminates stalled Git descendants before returning from a timed-out attempt', () => {
    const f = fixture(), bin = join(f.root, 'bin'), pidFile = join(f.root, 'child.pid'); mkdirSync(bin);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(bin, 'git'), `#!/bin/bash
for arg in "$@"; do
  if [ "$arg" = fetch ]; then
    exec >/dev/null 2>&1
    sleep 30 &
    echo $! > "$CHECKOUT_CHILD_PID"
    wait
    exit 1
  fi
done
exec "$REAL_GIT" "$@"
`); chmodSync(join(bin, 'git'), 0o755);
    const result = execute(f, { PATH: `${bin}:${process.env.PATH}`, REAL_GIT: realGit,
      CHECKOUT_CHILD_PID: pidFile, CHECKOUT_TIMEOUT_SECONDS: '0.2', CHECKOUT_MAX_ATTEMPTS: '1' });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const running = () => {
      const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      return status !== '' && !status.startsWith('Z');
    };
    try { expect(result.status).toBe(1); expect(running()).toBe(false); }
    finally { if (running()) process.kill(pid, 'SIGKILL'); }
  });

  it('cleans partial coverage receipts only after the source helpers were checked out', () => {
    const cleanup = job.steps.find((step: { name?: string }) => step.name === 'Clean temporary main coverage decision');
    expect(checkout.id).toBe('checkout');
    expect(cleanup.if).toBe("always() && steps.checkout.outcome == 'success' && github.event_name == 'push' && github.ref == 'refs/heads/main'");
  });
});
