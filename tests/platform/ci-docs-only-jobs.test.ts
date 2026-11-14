import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
const sourceJobs = [
  'typecheck', 'shell-production-build', 'patterns', 'react-doctor',
  'sync-client', 'agent-sdk-compatibility', 'unit', 'funded-postgres', 'collaboration-postgres', 'funded-host-root', 'native-stdout-linux', 'e2e',
];

interface GitHubFixture {
  event_name: string;
  ref: string;
  event: { pull_request?: { draft: boolean }; action?: string; changes?: { base?: unknown; title?: unknown; body?: unknown } };
}
const mainPush: GitHubFixture = { event_name: 'push', ref: 'refs/heads/main', event: {} };
function evaluateJobExpression(value: string, needs: unknown, github: GitHubFixture) {
  const body = value.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replaceAll('needs.ci-backend', 'needs["ci-backend"]');
  // Evaluate the actual trusted workflow expression with explicit GHA contexts.
  return Function('needs', 'github', 'inputs', 'vars', 'success', 'always', 'cancelled', `return (${body});`)(
    needs, github, {}, {}, () => true, () => true, () => false,
  );
}
function schedules(jobId: string, sourceChanges: boolean, docsChanges = false, parityChanges = false, github = mainPush) {
  const expression = workflow.jobs[jobId].if ?? 'success()';
  const needs = {
    'ci-backend':{result:'success',outputs:{provider:'hosted',infrastructure_fallback:'false'}},
    changes: {
      result:'success',
      outputs: {
        should_run: String(sourceChanges),
        docs_contract_tests: String(docsChanges),
        os_view_parity_tests: String(parityChanges),
      },
    },
  };
  return Boolean(evaluateJobExpression(expression, needs, github));
}

function aggregateStatus(docsResult: string) {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-ci-docs-'));
  const step = workflow.jobs['ci-results'].steps.find((value: { name?: string }) => value.name === 'Summarize required CI jobs');
  try {
    if (!step?.run) throw new Error('Missing required CI aggregate script');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI_TRIGGER_REQUESTED: 'true',
      SHOULD_RUN: 'false',
      CHANGES_RESULT: 'success',
      DOCS_CONTRACT_RESULT: docsResult,
      OS_VIEW_PARITY_RESULT: 'success',
      GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
    };
    for (const name of [
      'TYPECHECK', 'SHELL_PRODUCTION_BUILD', 'PATTERNS', 'REACT_DOCTOR',
      'SYNC_CLIENT', 'AGENT_SDK_COMPATIBILITY', 'UNIT', 'FUNDED_POSTGRES', 'COLLABORATION_POSTGRES', 'FUNDED_HOST_ROOT', 'NATIVE_STDOUT_LINUX', 'E2E',
    ]) env[`${name}_RESULT`] = 'skipped';
    execFileSync('bash', ['-c', step.run], { env, stdio: 'pipe' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('CI job admission for documentation changes', () => {
  it.each(sourceJobs)('does not allocate a runner/matrix for docs-only %s', (job) => {
    expect(schedules(job, false, true, true)).toBe(false);
  });

  it.each(sourceJobs)('still schedules %s when source checks are requested', (job) => {
    expect(schedules(job, true)).toBe(true);
  });

  it('schedules only the affected documentation/parity contracts', () => {
    expect(schedules('docs-contract', false, true, false)).toBe(true);
    expect(schedules('docs-contract', false, false, true)).toBe(false);
    expect(schedules('os-view-parity', false, true, false)).toBe(false);
    expect(schedules('os-view-parity', false, true, true)).toBe(true);
    expect(schedules('ci-results', false, true, true)).toBe(true);
  });

  it.each([
    ['main push', mainPush],
    ['ordinary PR', { event_name: 'pull_request', ref: 'refs/pull/1/merge', event: { action: 'synchronize', pull_request: { draft: false } } }],
    ['base edit', { event_name: 'pull_request', ref: 'refs/pull/1/merge', event: { action: 'edited', changes: { base: { ref: { from: 'stack/old' } } }, pull_request: { draft: false } } }],
  ] satisfies Array<[string, GitHubFixture]>)('keeps genuine CI Results for docs-only %s coverage', (_, github) => {
    expect(schedules('docs-contract', false, true, false, github)).toBe(true);
    expect(schedules('os-view-parity', false, true, false, github)).toBe(false);
    expect(schedules('ci-results', false, true, false, github)).toBe(true);
    expect(evaluateJobExpression(workflow.jobs['ci-results'].name, {}, github)).toBe('CI Results');
  });

  it.each(['title', 'body'])('executes authenticated coverage verification for %s-only edits', field => {
    const github: GitHubFixture = { event_name: 'pull_request', ref: 'refs/pull/1/merge',
      event: { action: 'edited', changes: { [field]: { from: 'previous text' } }, pull_request: { draft: false } } };
    expect(schedules('ci-results', false, false, false, github)).toBe(true);
    // The job runs and verifies a genuine exact-source aggregate; skipped
    // workload lanes alone cannot establish success.
    expect(evaluateJobExpression(workflow.jobs['ci-results'].name, {}, github)).toBe('CI Results');
    expect(schedules('docs-contract', false, false, false, github)).toBe(false);
    expect(schedules('os-view-parity', false, false, false, github)).toBe(false);
  });

  it.each(['opened', 'synchronize', 'reopened'])('publishes no required aggregate for a draft %s event', action => {
    // A draft cannot merge; an absent CI Results reads as expected, never red.
    const github: GitHubFixture = { event_name: 'pull_request', ref: 'refs/pull/1/merge',
      event: { action, pull_request: { draft: true } } };
    expect(schedules('ci-results', false, false, false, github)).toBe(false);
    expect(evaluateJobExpression(workflow.jobs['ci-results'].name, {}, github)).toBe('CI Draft (ignored)');
  });

  it.each(['opened', 'synchronize', 'reopened', 'edited'])('allocates no runner for a draft %s event', action => {
    // Drafts never run CI, so even change detection must not wait for a hosted runner.
    const github: GitHubFixture = { event_name: 'pull_request', ref: 'refs/pull/1/merge',
      event: { action, pull_request: { draft: true } } };
    const skipped = { result: 'skipped', outputs: {} };
    expect(Boolean(evaluateJobExpression(workflow.jobs.changes.if, { redirect: skipped }, github))).toBe(false);
    const needs = { redirect: skipped, changes: skipped, 'ci-backend': skipped };
    for (const [id, job] of Object.entries<{ if?: string; needs?: string | string[] }>(workflow.jobs)) {
      if (id === 'changes') continue;
      if (job.if === undefined) {
        // Without an explicit condition GitHub skips a job whose dependency was skipped.
        expect([job.needs].flat(), id).toContain('changes');
        continue;
      }
      expect(Boolean(evaluateJobExpression(job.if, needs, github)), id).toBe(false);
    }
  });

  it.each([
    ['main push', mainPush],
    ['ready PR', { event_name: 'pull_request', ref: 'refs/pull/1/merge', event: { action: 'synchronize', pull_request: { draft: false } } }],
    ['title edit', { event_name: 'pull_request', ref: 'refs/pull/1/merge', event: { action: 'edited', changes: { title: { from: 'old' } }, pull_request: { draft: false } } }],
  ] satisfies Array<[string, GitHubFixture]>)('still detects changes for a %s', (_, github) => {
    const needs = { redirect: { result: 'skipped', outputs: {} } };
    expect(Boolean(evaluateJobExpression(workflow.jobs.changes.if, needs, github))).toBe(true);
  });

  it('accepts intentional source-job skips while keeping the aggregate check', () => {
    expect(() => aggregateStatus('success')).not.toThrow();
  });

  it('still fails the aggregate when an affected documentation check fails', () => {
    expect(() => aggregateStatus('failure')).toThrow();
  });
});
