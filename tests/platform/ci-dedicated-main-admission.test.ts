import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const source = readFileSync(join(process.cwd(), '.github/workflows/ci-dedicated.yml'), 'utf8');
const workflow = parse(source) as { jobs: Record<string, { steps: Array<{ name?: string; env?: Record<string, string>; with?: { script?: string } }> }> };
const admit = workflow.jobs.benchmark.steps.find(step => step.name === 'Admit current source head')!;
const script = admit.with!.script!;

describe('main Linux admission', () => {
  it('reads the main delegation switch', () => {
    expect(admit.env?.MATRIX_CI_DEDICATED_MAIN).toBe('${{ vars.MATRIX_CI_DEDICATED_MAIN }}');
  });

  it('never leases the Linux host for main while main runs hosted', () => {
    const standDown = "if(admission.sourceKind==='main'&&process.env.MATRIX_CI_DEDICATED_MAIN!=='true'){";
    expect(script).toContain(standDown);
    expect(script).toContain("core.notice('Standing down: main runs hosted while MATRIX_CI_DEDICATED_MAIN is off');core.setOutput('admitted','false');return;");
    // It must decide before the controller creates its check or reserves a lease.
    expect(script.indexOf(standDown)).toBeGreaterThan(script.indexOf("if (!admission) { core.setOutput('admitted','false'); return; }"));
    expect(script.indexOf(standDown)).toBeLessThan(script.indexOf('github.rest.checks.create('));
  });
});
