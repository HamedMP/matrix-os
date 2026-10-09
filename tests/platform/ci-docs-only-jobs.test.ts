import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
const sourceJobs = [
  'typecheck', 'shell-production-build', 'patterns', 'react-doctor',
  'sync-client', 'agent-sdk-compatibility', 'unit', 'funded-postgres', 'e2e',
];

function schedules(jobId: string, sourceChanges: boolean, docsChanges = false, parityChanges = false) {
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
  // These workflow expressions use the same equality/boolean operators as JS.
  return Boolean(Function('needs', 'success', 'always', `return (${expression});`)(
    needs, () => true, () => true,
  ));
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
      'SYNC_CLIENT', 'AGENT_SDK_COMPATIBILITY', 'UNIT', 'FUNDED_POSTGRES', 'E2E',
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

  it('accepts intentional source-job skips while keeping the aggregate check', () => {
    expect(() => aggregateStatus('success')).not.toThrow();
  });

  it('still fails the aggregate when an affected documentation check fails', () => {
    expect(() => aggregateStatus('failure')).toThrow();
  });
});
