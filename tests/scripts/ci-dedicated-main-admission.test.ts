import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Evaluates the real benchmark job condition and run-name execution flag, the way GitHub does.
const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/ci-dedicated.yml'), 'utf8')) as { 'run-name': string; jobs: { benchmark: { if: string } } };
const startsWith = (text: string, prefix: string) => text.startsWith(prefix);
const contains = (values: string[], value: string) => values.includes(value);
const format = (text: string, ...args: unknown[]) => text.replace(/\{([0-9]+)\}/g, (_, i) => String(args[Number(i)]));
const condition = workflow.jobs.benchmark.if.replaceAll('github.event.pull_request.labels.*.name', '(github.event.pull_request?.labels??[]).map(label=>label.name)');
const admits = (vars: Record<string, string>, github: unknown) => Function('vars', 'github', 'startsWith', 'contains', `return (${condition});`)(vars, github, startsWith, contains);
const executes = (vars: Record<string, string>, github: unknown) => String(Function('vars', 'github', 'format', 'startsWith', `return (${workflow['run-name'].trim().slice(3, -2)});`)(vars, github, format, startsWith)).includes('execution=true');

const sha = 'a'.repeat(40);
const mainPush = (action: string, attempt: number, title: string) => ({ event_name: 'workflow_run', ref: 'refs/heads/main', event: { action, workflow_run: { id: 321, run_attempt: attempt, event: 'push', head_branch: 'main', head_sha: sha, display_title: title } } });
const prRun = { event_name: 'workflow_run', ref: 'refs/heads/main', event: { action: 'requested', workflow_run: { id: 322, run_attempt: 1, event: 'pull_request', head_branch: 'feature', head_sha: sha, display_title: `CI coverage-v1 · ${sha}` } } };
const prLabel = { event_name: 'pull_request_target', ref: 'refs/heads/main', event: { pull_request: { labels: [{ name: 'fast-ci' }, { name: 'ready-for-ci' }] } } };
const hosted = [{ MATRIX_CI_DEDICATED_ENABLED: 'true' }, { MATRIX_CI_DEDICATED_ENABLED: 'true', MATRIX_CI_DEDICATED_MAIN: 'false' }, { MATRIX_CI_DEDICATED_SHADOW: 'true', MATRIX_CI_DEDICATED_MAIN: 'true' }];
const delegated = { MATRIX_CI_DEDICATED_ENABLED: 'true', MATRIX_CI_DEDICATED_MAIN: 'true' };

describe('main Linux admission', () => {
  it.each([['requested push', mainPush('requested', 1, 'fix: something')], ['main re-run titled coverage', mainPush('in_progress', 2, `CI coverage-v1 · ${sha}`)]])('starts no %s controller while main runs hosted', (_name, github) => {
    for (const vars of hosted) {
      expect(admits(vars, github)).toBe(false);
      expect(executes(vars, github)).toBe(false);
    }
    expect(admits(delegated, github)).toBe(true);
    expect(executes(delegated, github)).toBe(true);
  });

  it('keeps PR admissions independent of the main switch', () => {
    for (const vars of [...hosted, delegated].filter(entry => entry.MATRIX_CI_DEDICATED_ENABLED === 'true')) {
      expect(admits(vars, prRun)).toBe(true);
      expect(executes(vars, prRun)).toBe(true);
      expect(admits(vars, prLabel)).toBe(true);
    }
  });
});
