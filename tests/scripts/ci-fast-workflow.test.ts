import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; 'runs-on': string; strategy?: { matrix?: Record<string, unknown> }; steps: Step[] };
const source = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const workflow = parse(source) as { concurrency: Record<string, unknown>; jobs: Record<string, Job> };
const scripts = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).scripts;
const runs = (job: Job) => job.steps.map(step => step.run ?? '').join('\n');

describe('fast CI preserves validation while removing serialized work', () => {
  it('starts independent unit, sync, build and E2E validation after classification', () => {
    for (const id of ['unit', 'e2e', 'sync-client', 'shell-production-build']) {
      expect(workflow.jobs[id].needs, id).toBe('changes');
    }
    const gate = workflow.jobs['ci-results'];
    for (const id of ['unit', 'e2e', 'sync-client', 'shell-production-build', 'funded-postgres', 'funded-host-root']) {
      expect(gate.needs).toContain(id);
    }
    expect(workflow.concurrency.queue).toBe('max');
    expect(workflow.concurrency['cancel-in-progress']).toBeUndefined();
  });

  it('builds prerequisites once in each funded and E2E job before direct test execution', () => {
    expect(scripts['test:prepare']).toContain('@matrix-os/integrations-mcp');
    expect(scripts['test:e2e:run']).toBe('vitest run --config vitest.e2e.config.ts');
    for (const id of ['e2e', 'funded-postgres']) {
      const commands = runs(workflow.jobs[id]);
      expect(commands.match(/bun run test:prepare/g)).toHaveLength(1);
      expect(commands).not.toMatch(/bun run test(?: |:e2e )/);
      expect(commands.indexOf('bun run test:prepare')).toBeLessThan(commands.indexOf(id === 'e2e' ? 'bun run test:e2e:run' : 'pnpm exec vitest run'));
    }
  });

  it('runs general and Electron E2E lanes in parallel without changing explicit regressions', () => {
    expect(workflow.jobs.e2e.strategy?.matrix?.lane).toEqual(['general', 'electron']);
    const steps = workflow.jobs.e2e.steps;
    expect(steps.find(s => s.name === 'Run E2E tests')?.if).toContain("matrix.lane == 'general'");
    expect(steps.find(s => s.name === 'Build Desktop for Electron E2E')?.if).toContain("matrix.lane == 'electron'");
    for (const step of steps.filter(s => s.env?.MATRIX_DESKTOP_E2E_REQUIRED === '1')) {
      expect(step.if).toContain("matrix.lane == 'electron'");
      expect(step.run).toContain('xvfb-run --auto-servernum bun run test:e2e:run');
    }
  });

  it('retains frozen installs and keyed Next and browser caches', () => {
    expect(source).not.toContain('runs-on: ${{');
    expect(workflow.jobs['funded-postgres']['runs-on']).toBe('ubuntu-latest');
    expect(workflow.jobs['funded-host-root']['runs-on']).toBe('ubuntu-latest');
    for (const id of ['shell-production-build', 'e2e']) {
      const cache = workflow.jobs[id].steps.find(s => s.uses?.startsWith('actions/cache@'));
      expect(cache?.with?.key).toContain('runner.os');
      expect(cache?.with?.key).toContain('runner.arch');
      expect(cache?.with?.key).toContain('node24-pnpm10.33.4');
      expect(cache?.with?.key).toContain('pnpm-lock.yaml');
      expect(runs(workflow.jobs[id])).toContain('pnpm install --frozen-lockfile');
    }
    const browsers = workflow.jobs.e2e.steps.filter(s => s.run?.includes('playwright install'));
    expect(browsers).toHaveLength(2);
    // Install verifies each workspace's potentially different Chromium revision even on cache hits.
    expect(browsers.every(s => !s.if?.includes('cache-hit'))).toBe(true);
  });

  it('uploads shard-specific JSON profiling even after failing tests', () => {
    const steps = workflow.jobs.unit.steps;
    const test = steps.find(s => s.run?.startsWith('bun run test --'));
    expect(test?.run).toContain('--reporter=default --reporter=json');
    expect(test?.run).toContain('output/ci/unit-${{ matrix.shard }}.json');
    const upload = steps.find(s => s.name === 'Upload unit profiling');
    expect(upload?.if).toContain('always()');
    expect(upload?.with?.name).toBe('unit-profile-${{ matrix.shard }}');
    expect(upload?.with?.['retention-days']).toBe(7);
  });
});
