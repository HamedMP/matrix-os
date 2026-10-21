import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as executionOriginHelpers from '../../scripts/ci/execution-origin.mjs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> };
type Job = { if?: string; needs?: string | string[]; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[]; 'timeout-minutes'?: number };
const workflow = YAML.parse(readFileSync(join(process.cwd(), '.github/workflows/preview-vps.yml'), 'utf8')) as {
  jobs: Record<string, Job>;
  on: { workflow_dispatch: { inputs: Record<string, { type: string; default?: boolean }> } };
  concurrency: { group: string };
};
const controller = 'a'.repeat(40);
const executionRef = `refs/heads/ci-execution/${controller}`;
const actualJobs = ['gate', 'build', 'deploy', 'publish_bundle', 'verify_inventory', 'teardown', 'reaper'];

function context(eventName: string, ref: string, allowed = 'false', action = 'bundle', reap = false) {
  return {
    github: { event_name: eventName, ref, run_id: 42, event: { action: '', pull_request: { number: 1907 }, label: { name: '' } } },
    inputs: { pr: '1907', bundle_only: true, reap },
    vars: { MATRIX_CI_ISOLATED_EXECUTION: 'true' },
    needs: { execution_origin: { result: allowed === 'true' ? 'success' : 'failure', outputs: { allowed } }, gate: { result: 'success', outputs: { action } }, build: { result: 'success' } },
  };
}
function expression(value: string, values: ReturnType<typeof context>): unknown {
  return runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    always: () => true, cancelled: () => false,
    startsWith: (value: string, prefix: string) => value.startsWith(prefix),
    ...values,
  }, { timeout: 100 });
}
function runs(name: string, values: ReturnType<typeof context>): boolean {
  const job = workflow.jobs[name];
  if (!job) return false;
  const needs = job.needs ? [job.needs].flat() : [];
  // A credentials-bearing job must explicitly depend on the proof job; a
  // reassuring condition elsewhere cannot fence its environment secrets.
  if (actualJobs.includes(name) && !needs.includes('execution_origin')) return true;
  return Boolean(job.if ? expression(job.if, values) : true);
}
function group(values: ReturnType<typeof context>): string {
  return workflow.concurrency.group.replace(/\$\{\{([\s\S]*?)\}\}/g,
    (_match, value: string) => String(expression(value, values)));
}

describe('Preview execution uses an isolated immutable workflow origin', () => {
  it('routes a Main manual request without running actual preview operations on Main', () => {
    const values = context('workflow_dispatch', 'refs/heads/main');
    expect(runs('route_execution', values)).toBe(true);
    expect(actualJobs.filter((name) => runs(name, values))).toEqual([]);
  });

  it('routes scheduled cleanup without binding the reaper credentials on Main', () => {
    const values = context('schedule', 'refs/heads/main');
    expect(runs('route_execution', values)).toBe(true);
    expect(actualJobs.filter((name) => runs(name, values))).toEqual([]);
  });

  it('runs bundle publication only after the isolated origin proof succeeds', () => {
    const values = context('workflow_dispatch', executionRef, 'true');
    expect(runs('route_execution', values)).toBe(false);
    expect(runs('execution_origin', values)).toBe(true);
    expect(runs('build', values)).toBe(true);
    expect(runs('publish_bundle', values)).toBe(true);
    expect(runs('deploy', values)).toBe(false);
    expect(runs('reaper', values)).toBe(false);
  });

  it('preserves PR previews on their existing authenticated PR event path', () => {
    const values = context('pull_request', 'refs/pull/1907/merge', 'true', 'deploy');
    expect(runs('route_execution', values)).toBe(false);
    expect(runs('gate', values)).toBe(true);
    expect(runs('build', values)).toBe(true);
    expect(runs('deploy', values)).toBe(true);
  });

  it('blocks every actual operation when the origin proof fails, regardless of selected action', () => {
    for (const action of ['bundle', 'deploy', 'deploy_existing', 'verify', 'teardown']) {
      const values = context('workflow_dispatch', executionRef, 'false', action, true);
      expect(actualJobs.filter((name) => runs(name, values)), action).toEqual([]);
    }
  });

  it('keeps the Main router bounded and secret-free with only one dispatch call', () => {
    const router = workflow.jobs.route_execution;
    expect(router).toBeDefined();
    if (!router) return;
    expect(router.permissions).toMatchObject({ contents: 'read', actions: 'write' });
    expect(router['timeout-minutes']).toBeLessThanOrEqual(5);
    const encoded = JSON.stringify(router);
    expect(encoded).not.toContain('secrets.');
    expect(encoded).not.toMatch(/publish-release|\/vps\/(deploy|provision)|PLATFORM_SECRET/);
    const scripts = router.steps.map((step) => step.with?.script ?? step.run ?? '').join('\n');
    expect(scripts.match(/createWorkflowDispatch\s*\(/g)).toHaveLength(1);
    expect(scripts).toContain('MATRIX_CI_CONTROLLER_SHA');
    expect(scripts).toContain('ci-execution/');
  });

  it('verifies the actual workflow identity against the reviewed controller before permitting secrets', () => {
    const guard = workflow.jobs.execution_origin;
    expect(guard).toBeDefined();
    if (!guard) return;
    expect(JSON.stringify(guard)).not.toContain('secrets.');
    const scripts = guard.steps.map((step) => step.with?.script ?? step.run ?? '').join('\n');
    expect(scripts).toContain('verifyIsolatedExecutionOrigin');
    expect(JSON.stringify(guard)).toContain('github.workflow_ref');
    expect(JSON.stringify(guard)).toContain('github.workflow_sha');
    expect(JSON.stringify(guard)).toContain('MATRIX_CI_CONTROLLER_SHA');
    for (const name of ['route_execution', 'execution_origin']) {
      const checkout = workflow.jobs[name]?.steps.find((candidate) => candidate.name === 'Checkout reviewed origin verifier');
      const pinnedCheckout = /^actions\/checkout@[a-f0-9]{40}$/;
      expect(checkout?.uses, name).toMatch(pinnedCheckout);
      for (const unsafe of ['actions/checkout@v6', 'actions/checkout@d23441a', `untrusted/checkout@${'a'.repeat(40)}`]) {
        expect(unsafe).not.toMatch(pinnedCheckout);
      }
      expect(checkout?.with, name).toMatchObject({ ref: '${{ vars.MATRIX_CI_CONTROLLER_SHA }}', 'persist-credentials': false });
    }
    for (const name of actualJobs) {
      const needs = workflow.jobs[name]?.needs;
      expect(needs ? [needs].flat() : [], name).toContain('execution_origin');
    }
  });

  it('reaps only through the verified isolated manual maintenance request', () => {
    expect(workflow.on.workflow_dispatch.inputs.reap).toMatchObject({ type: 'boolean', default: false });
    expect(runs('reaper', context('workflow_dispatch', executionRef, 'true', 'skip', true))).toBe(true);
    expect(runs('gate', context('workflow_dispatch', executionRef, 'true', 'skip', true))).toBe(false);
    expect(runs('reaper', context('workflow_dispatch', executionRef, 'true', 'skip', false))).toBe(false);
    const cancel = (workflow as unknown as { concurrency: { 'cancel-in-progress': string } }).concurrency['cancel-in-progress'];
    expect(expression(cancel, context('workflow_dispatch', executionRef, 'true', 'skip', true))).toBe(false);
  });

  it.each(['', 'false'])('preserves staged legacy execution while the flag is %j', (flag) => {
    const manual = context('workflow_dispatch', 'refs/heads/main', 'true');
    manual.vars.MATRIX_CI_ISOLATED_EXECUTION = flag;
    expect(runs('route_execution', manual)).toBe(false);
    expect(runs('execution_origin', manual)).toBe(true);
    expect(runs('build', manual)).toBe(true);
    const scheduled = context('schedule', 'refs/heads/main', 'true', 'skip');
    scheduled.vars.MATRIX_CI_ISOLATED_EXECUTION = flag;
    expect(runs('route_execution', scheduled)).toBe(false);
    expect(runs('execution_origin', scheduled)).toBe(true);
    expect(runs('reaper', scheduled)).toBe(true);
  });

  it('separates route and execution concurrency so the child cannot cancel its router', () => {
    expect(group(context('workflow_dispatch', 'refs/heads/main')))
      .not.toBe(group(context('workflow_dispatch', executionRef)));
    expect(group(context('schedule', 'refs/heads/main', 'false', 'skip', true)))
      .not.toBe(group(context('workflow_dispatch', executionRef, 'true', 'skip', true)));
  });
});

// Execute the actual github-script body with synthetic GitHub responses. The
// shared verifier is imported from the real checkout, not reimplemented here.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
function scriptFixture(eventName = 'workflow_dispatch') {
  const execution = 'b'.repeat(40), tree = 'c'.repeat(40), main = 'd'.repeat(40);
  const commits: Record<string, { sha: string; tree: { sha: string }; parents: { sha: string }[] }> = {
    [controller]: { sha: controller, tree: { sha: tree }, parents: [{ sha: 'e'.repeat(40) }] },
    [execution]: { sha: execution, tree: { sha: tree }, parents: [{ sha: controller }] },
  };
  const github = { rest: {
    git: { getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({ data: commits[commit_sha] })) },
    repos: {
      getBranch: vi.fn(async ({ branch }: { branch: string }) => ({ data: { name: branch, commit: { sha: branch === 'main' ? main : execution } } })),
      compareCommitsWithBasehead: vi.fn(async () => ({ data: { status: 'ahead', merge_base_commit: { sha: controller } } })),
    },
    actions: { createWorkflowDispatch: vi.fn(async () => ({ status: 204 })) },
  } };
  const runtimeContext = { repo: { owner: 'HamedMP', repo: 'matrix-os' }, eventName,
    ref: executionRef, sha: execution,
    payload: { inputs: { pr: '1907', version: '', bundle_only: 'true', verify_inventory: 'false', teardown_preview: 'false', reap: 'false' } } };
  const env = { GITHUB_WORKSPACE: process.cwd(), MATRIX_CI_CONTROLLER_SHA: controller,
    ISOLATED_EXECUTION: 'true', PREVIEW_WORKFLOW_REF: `HamedMP/matrix-os/.github/workflows/preview-vps.yml@${executionRef}`, PREVIEW_WORKFLOW_SHA: execution };
  const core = { setOutput: vi.fn(), notice: vi.fn() };
  return { github, runtimeContext, env, core, commits, execution };
}
async function runActualScript(jobName: string, f: ReturnType<typeof scriptFixture>) {
  const body = workflow.jobs[jobName]?.steps.find((candidate) => candidate.with?.script)?.with?.script;
  if (!body) throw new Error(`Missing actual github-script body: ${jobName}`);
  // Vitest's VM cannot import from AsyncFunction. Replace only the loader;
  // the workflow computes its real path and runs the actual protected helper.
  const importCall = 'await import(';
  if (body.split(importCall).length !== 2) throw new Error('Expected one protected workflow helper import');
  const script = body.replace(importCall, 'await loadHelper(');
  const loadHelper = async (url: string) => {
    if (url !== pathToFileURL(resolve(process.cwd(), 'scripts/ci/execution-origin.mjs')).href) {
      throw new Error('Unexpected protected workflow helper path');
    }
    return executionOriginHelpers;
  };
  await new AsyncFunction('github', 'context', 'core', 'require', 'process', 'loadHelper', script)(
    f.github, f.runtimeContext, f.core, createRequire(import.meta.url), { env: f.env }, loadHelper);
}

describe('Actual isolated preview router and origin scripts', () => {
  it.each(['workflow_dispatch', 'schedule'])('dispatches %s once to the verified P with the intended operation only', async (eventName) => {
    const f = scriptFixture(eventName);
    await runActualScript('route_execution', f);
    expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledExactlyOnceWith({
      ...f.runtimeContext.repo, workflow_id: 'preview-vps.yml', ref: `ci-execution/${controller}`,
      inputs: { pr: eventName === 'schedule' ? '0' : '1907', version: '',
        bundle_only: eventName === 'schedule' ? 'false' : 'true', verify_inventory: 'false', teardown_preview: 'false', reap: String(eventName === 'schedule') },
      request: { timeout: 10000 },
    });
  });

  it('rejects any helper path outside the actual protected module', async () => {
    const f = scriptFixture();
    f.env.GITHUB_WORKSPACE = '/tmp/unreviewed-preview-source';
    await expect(runActualScript('route_execution', f)).rejects.toThrow('Unexpected protected workflow helper path');
    expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(f.core.setOutput).not.toHaveBeenCalledWith('allowed', 'true');
  });

  it('never dispatches when the execution tree differs from the reviewed pin', async () => {
    const f = scriptFixture();
    f.commits[f.execution]!.tree.sha = 'f'.repeat(40);
    await expect(runActualScript('route_execution', f)).rejects.toThrow();
    expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('rejects a maintenance request mixed with a PR operation before granting credentials', async () => {
    const f = scriptFixture();
    f.runtimeContext.payload.inputs.reap = 'true';
    await expect(runActualScript('execution_origin', f)).rejects.toThrow('Invalid isolated maintenance request');
    expect(f.core.setOutput).not.toHaveBeenCalledWith('allowed', 'true');
  });

  it('does not retry an invoked dispatch with an unknown external outcome', async () => {
    const f = scriptFixture();
    f.github.rest.actions.createWorkflowDispatch.mockRejectedValue(new Error('transport interrupted'));
    await expect(runActualScript('route_execution', f)).rejects.toThrow('transport interrupted');
    expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });

  it('permits credentials only after verifying the actual workflow SHA/ref', async () => {
    const f = scriptFixture();
    await runActualScript('execution_origin', f);
    expect(f.core.setOutput).toHaveBeenCalledWith('allowed', 'true');
    expect(f.core.setOutput).toHaveBeenCalledWith('trusted_ref', f.execution);
    const wrong = scriptFixture();
    wrong.env.PREVIEW_WORKFLOW_SHA = controller;
    await expect(runActualScript('execution_origin', wrong)).rejects.toThrow();
    expect(wrong.core.setOutput).not.toHaveBeenCalledWith('allowed', 'true');
  });

  it.each(['pull_request', 'legacy'])('keeps the %s bootstrap control independent of an isolated verifier checkout', async (mode) => {
    const f = scriptFixture(mode === 'pull_request' ? 'pull_request' : 'workflow_dispatch');
    if (mode === 'legacy') f.env.ISOLATED_EXECUTION = '';
    await runActualScript('execution_origin', f);
    expect(f.core.setOutput).toHaveBeenCalledWith('allowed', 'true');
    expect(f.core.setOutput).toHaveBeenCalledWith('mode', mode);
    expect(f.core.setOutput).toHaveBeenCalledWith('trusted_ref', 'main');
    expect(f.github.rest.git.getCommit).not.toHaveBeenCalled();
  });
});
