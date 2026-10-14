import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string; with?: { script?: string } };
type Job = { name?: string; if?: string; permissions?: Record<string, string>; outputs?: Record<string, string>; steps?: Step[] };
const load = (file: string) => {
  const source = readFileSync(join(process.cwd(), '.github/workflows', file), 'utf8');
  return { source, workflow: parse(source) as { jobs: Record<string, Job> } };
};
const ci = load('ci.yml');
const jobs = Object.values(ci.workflow.jobs);
const byName = (name: string) => {
  const found = jobs.filter(job => job.name === name);
  expect(found, name).toHaveLength(1);
  return found[0];
};
const changes = ci.workflow.jobs.changes;
const step = (name: string) => changes.steps!.find(entry => entry.name === name)!;
const GUARD = "needs.changes.outputs.reused != 'true'";

describe('main CI reuse of qualified PR coverage', () => {
  it('resolves reuse between source detection and Linux routing, only for main pushes behind the switch', () => {
    const names = changes.steps!.map(entry => entry.name);
    const at = names.indexOf('Resolve reusable PR coverage');
    expect(at).toBeGreaterThan(names.indexOf('Detect source changes'));
    expect(at).toBeLessThan(names.indexOf('Select guarded Linux delegation'));
    const reuse = step('Resolve reusable PR coverage');
    expect(reuse.id).toBe('reuse');
    for (const term of ["github.event_name == 'push'", "github.ref == 'refs/heads/main'", "vars.MATRIX_CI_MAIN_REUSE == 'true'", "steps.changed.outputs.should_run == 'true'"]) expect(reuse.if).toContain(term);
    expect(reuse.with?.script).toContain("core.setOutput('reused','false')");
    expect(changes.outputs?.reused).toBe("${{ steps.reuse.outputs.reused == 'true' && 'true' || 'false' }}");
  });

  it('gives the detector read access to checks and nothing more', () => {
    expect(changes.permissions).toEqual({ actions: 'read', checks: 'read', contents: 'read', 'pull-requests': 'read' });
  });

  it('turns Linux routing off and records the proof in the decision receipt when reused', () => {
    const route = step('Select guarded Linux delegation');
    expect(route.env?.REUSED).toBe('${{ steps.reuse.outputs.reused }}');
    expect(route.run).toContain("if(process.env.REUSED==='true'){appendFileSync(process.env.GITHUB_OUTPUT,'eligible=false\\nrequired=false\\nmode=shadow\\n');");
    expect(step('Record exact main coverage decision').env?.REUSED_FROM).toBe("${{ steps.reuse.outputs.reused == 'true' && steps.reuse.outputs.reused_from || '' }}");
  });

  it.each([
    'Type Check', 'Shell Production Build', 'Agent SDK 0.3.251 Compatibility', 'Unit Tests (${{ matrix.shard }}/4)',
    'E2E Tests (${{ matrix.lane }})', 'Docs Contract Tests', 'OS View Parity', 'CI Backend Decision', 'Verified Dedicated Linux Qualification',
  ])('skips heavy lane %s when coverage is reused', name => {
    expect(byName(name).if).toContain(GUARD);
  });

  it.each(['Pattern Scan', 'React Doctor', 'Sync Client Package', 'Funded Settlement PostgreSQL', 'Protected Funded Host Root Contracts'])('keeps light lane %s running', name => {
    expect(byName(name).if ?? '').not.toContain(GUARD);
  });

  it('always runs the CI Results aggregate', () => {
    expect(ci.workflow.jobs['ci-results'].if ?? '').not.toContain(GUARD);
  });

  it('stands the main Linux controller down only behind the same switch and never on errors', () => {
    const { source } = load('ci-dedicated.yml');
    expect(source).toContain('MATRIX_CI_MAIN_REUSE: ${{ vars.MATRIX_CI_MAIN_REUSE }}');
    expect(source).toContain("if(admission.sourceKind==='main'&&process.env.MATRIX_CI_MAIN_REUSE==='true'){");
    expect(source).toContain("if(reuse.reused){core.notice(`Standing down: main reuses PR #${reuse.reusedFrom.prNumber} qualified coverage`);core.setOutput('admitted','false');return;}");
    expect(source).toContain('}catch(error){core.warning(`Main reuse check unavailable; qualifying on Linux:');
  });
});
