import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const source = readFileSync(join(process.cwd(), '.github/workflows/ci-dedicated.yml'), 'utf8');
const workflow = parse(source) as { 'run-name': string; jobs: Record<string, { if: string; steps: Array<{ name?: string; with?: { script?: string } }> }> };
// Main push controllers exist only while main is delegated to Linux.
const MAIN_DELEGATED = "(github.event.workflow_run.event != 'push' || (vars.MATRIX_CI_DEDICATED_ENABLED == 'true' && vars.MATRIX_CI_DEDICATED_MAIN == 'true'))";

describe('main Linux admission', () => {
  it('never starts a main push controller while main runs hosted', () => {
    const condition = workflow.jobs.benchmark.if;
    expect(condition).toContain(`(github.event_name == 'workflow_run' && ${MAIN_DELEGATED} && (((`);
    // Every workflow_run admission clause, including main re-runs titled CI coverage-v1, sits behind the guard.
    const guarded = condition.slice(condition.indexOf(MAIN_DELEGATED));
    expect(guarded).toContain("startsWith(github.event.workflow_run.display_title, 'CI coverage-v1 · ')");
    expect(guarded).toContain("github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main'");
  });

  it('labels a main controller as executing only while main is delegated', () => {
    expect(workflow['run-name']).toContain(`format('dedicated-refresh-v2 execution={0} request={1} title={2}', (${MAIN_DELEGATED} && (`);
  });

  it('keeps PR admissions independent of the main switch', () => {
    expect(workflow.jobs.benchmark.if).toContain("(github.event_name == 'pull_request_target' && contains(github.event.pull_request.labels.*.name, 'fast-ci'))");
    expect(workflow.jobs.benchmark.if.indexOf("pull_request_target")).toBeLessThan(workflow.jobs.benchmark.if.indexOf(MAIN_DELEGATED));
  });
});
