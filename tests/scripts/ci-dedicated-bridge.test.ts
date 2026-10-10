import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

function workflow() {
  return parse(readFileSync('.github/workflows/ci-dedicated.yml', 'utf8'));
}

async function admit(overrides: Record<string, unknown> = {}, inputSha = '') {
  vi.stubEnv('INPUT_SHA', inputSha);
  const sha = 'a'.repeat(40);
  const outputs: Record<string, string> = {};
  const pull = {
    state: 'open', draft: false, labels: [{ name: 'ready-for-ci' }],
    head: { sha, repo: { full_name: 'HamedMP/matrix-os' } }, ...overrides,
  };
  const github = { rest: {
    pulls: { get: vi.fn(async () => ({ data: pull })) },
    repos: { getCommit: vi.fn(async () => ({})) },
    checks: { create: vi.fn(async () => ({ data: { id: 123 } })) },
  } };
  const context = {
    repo: { owner: 'HamedMP', repo: 'matrix-os' }, sha,
    eventName: 'pull_request_target',
    payload: { pull_request: { number: 2440, head: { sha } } },
    serverUrl: 'https://github.com', runId: 1,
  };
  const core = { setOutput: (key: string, value: string) => { outputs[key] = value; } };
  const script = workflow().jobs.benchmark.steps.find((s: { id?: string }) => s.id === 'admit').with.script;
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction('github', 'context', 'core', script)(github, context, core);
  return { outputs, github };
}

afterEach(() => vi.unstubAllEnvs());

describe('dedicated CI trusted dispatcher', () => {
  it('admits and attaches a check to the current labeled source head', async () => {
    const { outputs, github } = await admit();
    expect(outputs).toEqual({ sha: 'a'.repeat(40), check_id: '123', admitted: 'true' });
    expect(github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ head_sha: 'a'.repeat(40) }));
  });

  it.each([
    { state: 'closed' },
    { draft: true },
    { labels: [] },
    { head: { sha: 'b'.repeat(40), repo: { full_name: 'HamedMP/matrix-os' } } },
    { head: { sha: 'a'.repeat(40), repo: { full_name: 'other/matrix-os' } } },
  ])('rejects an unadmitted source without starting a check: %j', async (override) => {
    const { outputs, github } = await admit(override);
    expect(outputs).toEqual({ admitted: 'false' });
    expect(github.rest.checks.create).not.toHaveBeenCalled();
    expect(github.rest.repos.getCommit).not.toHaveBeenCalled();
  });

  it('uses the default-branch controller and a protected secret environment', () => {
    const value = workflow();
    expect(value.on.pull_request_target).toBeDefined();
    expect(value.on.pull_request).toBeUndefined();
    expect(value.jobs.benchmark.environment).toBe('matrix-ci');
    expect(value.jobs.benchmark.if).toContain("vars.MATRIX_CI_DEDICATED_ENABLED == 'true'");
    expect(value.permissions).toEqual({ contents: 'read', checks: 'write', 'pull-requests': 'read' });
  });

  it('never checks out or executes a pull request on the trusted controller', () => {
    const steps = workflow().jobs.benchmark.steps;
    expect(steps.some((s: { uses?: string }) => s.uses?.startsWith('actions/checkout'))).toBe(false);
    const ssh = steps.find((s: { name?: string }) => s.name === 'Dispatch isolated benchmark');
    expect(ssh.run).toContain('StrictHostKeyChecking=yes');
    expect(ssh.run).toContain('IdentitiesOnly=yes');
    expect(ssh.run).toContain('"run $SOURCE_SHA $SUITE"');
    expect(ssh.run).not.toContain('${{');
    expect(ssh.run).toContain('[[ $SOURCE_SHA =~ ^[a-f0-9]{40}$ ]]');
    expect(ssh.run).toContain('trap');
    expect(ssh.env.CI_SSH_KEY).toContain('secrets.CI_RUNNER_SSH_KEY');
  });

  it('binds check results to the immutable validated source head', () => {
    const steps = workflow().jobs.benchmark.steps;
    const admit = steps.find((s: { id?: string }) => s.id === 'admit').with.script;
    expect(admit).toContain('github.rest.pulls.get');
    expect(admit).toContain('pull.head.sha !== context.payload.pull_request.head.sha');
    expect(admit).toContain('pull.head.repo?.full_name !==');
    expect(admit).toContain("labels.some");
    expect(admit).toContain('head_sha: sha');
    const settle = steps.find((s: { name?: string }) => s.name === 'Settle source-head check');
    expect(settle.if).toContain('always()');
    expect(settle.with.script).toContain('github.rest.checks.update');
    expect(settle.with.script).toContain("conclusion: success ? 'success' : 'failure'");
  });
});
