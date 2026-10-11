import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
const sourceJobs = [
  'typecheck', 'shell-production-build', 'patterns', 'react-doctor',
  'sync-client', 'agent-sdk-compatibility', 'unit', 'funded-postgres', 'funded-host-root', 'e2e',
];

interface GitHubFixture {
  event_name: string;
  ref: string;
  event: { action?: string; changes?: { base?: unknown; title?: unknown; body?: unknown } };
}
const mainPush: GitHubFixture = { event_name: 'push', ref: 'refs/heads/main', event: {} };
function evaluateJobExpression(value: string, needs: unknown, github: GitHubFixture) {
  const body = value.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  // Evaluate the actual trusted workflow expression with explicit GHA contexts.
  return Function('needs', 'github', 'inputs', 'vars', 'success', 'always', `return (${body});`)(
    needs, github, {}, {}, () => true, () => true,
  );
}
function schedules(jobId: string, sourceChanges: boolean, docsChanges = false, parityChanges = false, github = mainPush) {
  const expression = workflow.jobs[jobId].if ?? 'success()';
  const needs = {
    changes: {
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
  const step = workflow.jobs['ci-results'].steps.find((value: { run?: string }) => value.run);
  try {
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
      'SYNC_CLIENT', 'AGENT_SDK_COMPATIBILITY', 'UNIT', 'FUNDED_POSTGRES', 'FUNDED_HOST_ROOT', 'E2E',
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
    ['ordinary PR', { event_name: 'pull_request', ref: 'refs/pull/1/merge', event: { action: 'synchronize' } }],
    ['base edit', { event_name: 'pull_request', ref: 'refs/pull/1/merge', event: { action: 'edited', changes: { base: { ref: { from: 'stack/old' } } } } }],
  ] satisfies Array<[string, GitHubFixture]>)('keeps genuine CI Results for docs-only %s coverage', (_, github) => {
    expect(schedules('docs-contract', false, true, false, github)).toBe(true);
    expect(schedules('os-view-parity', false, true, false, github)).toBe(false);
    expect(schedules('ci-results', false, true, false, github)).toBe(true);
    expect(evaluateJobExpression(workflow.jobs['ci-results'].name, {}, github)).toBe('CI Results');
  });

  it.each(['title', 'body'])('keeps %s-only edits from publishing a replacement required aggregate', field => {
    const github: GitHubFixture = { event_name: 'pull_request', ref: 'refs/pull/1/merge',
      event: { action: 'edited', changes: { [field]: { from: 'previous text' } } } };
    expect(schedules('ci-results', false, false, false, github)).toBe(false);
    // A skipped job named CI Results could clear a real failure. Both the
    // suppression and the distinct check identity must remain in the workflow.
    expect(evaluateJobExpression(workflow.jobs['ci-results'].name, {}, github)).toBe('CI Metadata (ignored)');
    expect(schedules('docs-contract', false, false, false, github)).toBe(false);
    expect(schedules('os-view-parity', false, false, false, github)).toBe(false);
  });

  it('accepts intentional source-job skips while keeping the aggregate check', () => {
    expect(() => aggregateStatus('success')).not.toThrow();
  });

  it('still fails the aggregate when an affected documentation check fails', () => {
    expect(() => aggregateStatus('failure')).toThrow();
  });
});
