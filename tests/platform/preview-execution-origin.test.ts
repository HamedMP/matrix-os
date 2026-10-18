import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
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
  });

  it('separates route and execution concurrency so the child cannot cancel its router', () => {
    expect(group(context('workflow_dispatch', 'refs/heads/main')))
      .not.toBe(group(context('workflow_dispatch', executionRef)));
    expect(group(context('schedule', 'refs/heads/main', 'false', 'skip', true)))
      .not.toBe(group(context('workflow_dispatch', executionRef, 'true', 'skip', true)));
  });
});
