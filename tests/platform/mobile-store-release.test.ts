import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import ts from 'typescript';

const root = process.cwd();
const scratch: string[] = [];
const buildId = '11111111-1111-4111-8111-111111111111';
const sha = 'a'.repeat(40);
const projectId = 'cdd27a8d-aebc-446a-8e18-d735c78d3b2d';

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function release(platform = 'ios', overrides = {}, cliFailure = '', token = 'test-token', environment = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-store-release-test-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'bin'));
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  writeFileSync(join(dir, 'build.json'), JSON.stringify([{
    id: buildId, platform: platform.toUpperCase(), status: 'FINISHED',
    // Shape verified against eas-cli 24.8.0's BuildFragment: project is `app`.
    app: { id: projectId }, appIdentifier: 'com.matrixos.mobile',
    buildProfile: 'production', distribution: 'STORE', gitCommitHash: sha, ...overrides,
  }]));
  // Only the external EAS boundary is replaced; run the production shell script.
  writeFileSync(join(dir, 'bin/pnpm'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$3" in
  build) [ "$TEST_CLI_FAILURE" != build ] || exit 1; cat "$TEST_BUILD_JSON" ;;
  submit) [ "$TEST_CLI_FAILURE" != submit ] || exit 1 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  const result = spawnSync('bash', [join(root, 'scripts/ci/mobile-store-release.sh'), platform], {
    cwd: join(root, 'apps/mobile'), encoding: 'utf8',
    env: {
      ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      EXPO_TOKEN: token, EAS_CLI_VERSION: '24.8.0', GITHUB_SHA: sha,
      GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
      RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      TEST_CALLS: calls, TEST_BUILD_JSON: join(dir, 'build.json'), TEST_CLI_FAILURE: cliFailure,
      ...environment,
    },
  });
  return { ...result, calls: readFileSync(calls, 'utf8'), files: dir };
}

describe('mobile store release boundary', () => {
  it.each(['ios', 'android'])('builds and submits the returned %s build ID', (platform) => {
    const result = release(platform);
    expect(result.status, result.stderr).toBe(0);
    const calls = result.calls.trim().split('\n');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(`build --platform ${platform} --profile production`);
    expect(calls[0]).toContain('--wait --non-interactive --freeze-credentials --json');
    expect(calls[1]).toContain(`submit --platform ${platform} --profile ${platform === 'ios' ? 'testflight' : 'play-internal'} --id ${buildId}`);
    expect(calls[1]).toContain('--wait --non-interactive');
    if (platform === 'ios') expect(calls[1]).toContain('--no-auto-testflight-setup');
    expect(result.calls).not.toContain('--latest');
  });

  it.each([
    { status: 'ERRORED' }, { status: 'IN_QUEUE' }, { platform: 'ANDROID' },
    { app: { id: 'another-project' } }, { gitCommitHash: 'b'.repeat(40) }, { id: 'invalid-id' },
  ])('never submits an unexpected build result: %j', (overrides) => {
    const result = release('ios', overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('submission refused');
    expect(result.calls).toContain('build --platform ios');
    expect(result.calls).not.toContain('submit');
  });

  it('stops before submission when the build command fails', () => {
    const result = release('ios', {}, 'build');
    expect(result.status).not.toBe(0);
    expect(result.calls).not.toContain('submit');
  });

  it('reports a failed submission and cleans private build output', () => {
    const result = release('ios', {}, 'submit');
    expect(result.status).not.toBe(0);
    expect(result.calls).toContain('submit');
    expect(readdirSync(result.files).filter((name) => name.startsWith('eas-store-'))).toEqual([]);
  });

  it('requires a token before starting a paid build', () => {
    const result = release('ios', {}, '', '');
    expect(result.status).not.toBe(0);
    expect(result.calls).toBe('');
  });

  it('rejects unsupported platforms before starting a build', () => {
    const result = release('all');
    expect(result.status).not.toBe(0);
    expect(result.calls).toBe('');
  });

  it.each([
    { GITHUB_REF: 'refs/heads/unreviewed' },
    { GITHUB_EVENT_NAME: 'pull_request' },
  ])('rejects an untrusted release context: %j', (environment) => {
    const result = release('ios', {}, '', 'test-token', environment);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manual workflow run from main');
    expect(result.calls).toBe('');
  });
});

describe('mobile store workflow configuration', () => {
  it.each([
    ['mobile-ios-testflight.yml', 'ios', 'mobile-ios-testflight'],
    ['mobile-android-internal.yml', 'android', 'mobile-android-internal'],
  ])('keeps %s manual, main-only, and behind its environment', (file, platform, environment) => {
    const workflow = parse(readFileSync(join(root, '.github/workflows', file), 'utf8'));
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    const job = workflow.jobs.release;
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe(environment);
    expect(job['runs-on']).toBe('ubuntu-latest');
    const step = job.steps.find((entry: { name?: string }) => entry.name === 'Build and submit');
    expect(step.run).toBe(`bash scripts/ci/mobile-store-release.sh ${platform}`);
    expect(step.env.EXPO_TOKEN).toBe('${{ secrets.EXPO_TOKEN }}');
    for (const entry of job.steps) {
      if (entry.uses) expect(entry.uses).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(job.steps.some((entry: { run?: string }) => entry.run === 'pnpm install --frozen-lockfile --ignore-scripts')).toBe(true);
    expect(job.steps.some((entry: { run?: string }) => entry.run?.includes('jest --runInBand'))).toBe(true);
  });

  it('pins beta destinations independently of the production submit profile', () => {
    const parsed = ts.parseConfigFileTextToJson('eas.json', readFileSync(join(root, 'apps/mobile/eas.json'), 'utf8'));
    expect(parsed.error).toBeUndefined();
    const eas = parsed.config;
    expect(eas.submit.testflight.ios.ascAppId).toBe('6785629815');
    expect(eas.submit['play-internal'].android).toEqual({ track: 'internal', releaseStatus: 'completed' });
    expect(eas.build.production.autoIncrement).toBe(true);
    expect(eas.build.production.android.buildType).toBe('app-bundle');
  });
});
