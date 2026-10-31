import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Job = { 'timeout-minutes'?: number; needs?: string | string[]; 'runs-on': string; strategy?: { matrix?: Record<string, unknown> }; steps: Step[] };
const source = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const workflow = parse(source) as { concurrency: Record<string, unknown>; jobs: Record<string, Job> };
const scripts = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).scripts;
const runs = (job: Job) => job.steps.map(step => step.run ?? '').join('\n');

describe('fast CI preserves validation while removing serialized work', () => {
  it('bootstraps every Bun lane with the exact qualified version without API tag discovery', () => {
    const setups = Object.values(workflow.jobs).flatMap(job =>
      job.steps.filter(step => step.uses?.startsWith('oven-sh/setup-bun@')),
    );
    expect(setups.length).toBeGreaterThan(0);
    for (const step of setups) {
      // setup-bun resolves only floating versions through GitHub's tags API.
      // 1.4.3 is the runtime used by the preceding successful full CI run.
      expect(step.with?.['bun-version']).toBe('1.4.3');
      expect(step.with?.['bun-download-url']).toBeUndefined();
    }
  });

  it('installs the real pattern scanner dependency before every unit shard', () => {
    const steps = workflow.jobs.unit.steps;
    const scanner = steps.findIndex(step => step.run === 'sudo apt-get install -y ripgrep');
    const test = steps.findIndex(step => step.run?.startsWith('GITHUB_SHA="$UNIT_SOURCE_SHA" bun run test --'));
    expect(scanner).toBeGreaterThanOrEqual(0);
    expect(scanner).toBeLessThan(test);
    expect(steps[scanner]?.if).toBe(steps[test]?.if);
    expect(workflow.jobs.unit.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
  });

  it('starts independent hosted lanes after backend selection while sync starts after classification', () => {
    expect(workflow.jobs['isolated-ci-backend'].needs).toBe('changes');
    expect(workflow.jobs['ci-backend'].needs).toEqual(['changes', 'isolated-ci-backend']);
    for (const id of ['unit', 'e2e', 'shell-production-build']) {
      // Backend admission chooses Linux or hosted recovery; workload lanes still
      // run in parallel rather than waiting for another workload's result.
      expect(workflow.jobs[id].needs, id).toEqual(['changes', 'ci-backend']);
    }
    expect(workflow.jobs['sync-client'].needs).toBe('changes');
    const gate = workflow.jobs['ci-results'];
    for (const id of ['unit', 'e2e', 'sync-client', 'shell-production-build', 'funded-postgres', 'funded-host-root']) {
      expect(gate.needs).toContain(id);
    }
    expect(workflow.concurrency.queue).toBe('max');
    expect(workflow.concurrency['cancel-in-progress']).toBeUndefined();
  });

  it('builds prerequisites once in each funded and E2E job before direct test execution', () => {
    expect(scripts['test:prepare']).toContain('@matrix-os/integrations-mcp');
    expect(scripts['test:prepare'].match(/node packages\/gateway\/native\/build\.mjs/g)).toHaveLength(1);
    expect(scripts['test:e2e:run']).toBe('NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage" node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts');
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

  it('runs the account organization picker after the required Electron build', () => {
    const steps = workflow.jobs.e2e.steps;
    const build = steps.findIndex(step => step.name === 'Build Desktop for Electron E2E');
    const picker = steps.findIndex(step => step.name === 'Run required Desktop account organization picker');
    expect(picker).toBeGreaterThan(build);
    expect(steps[picker]?.if).toContain("matrix.lane == 'electron'");
    expect(steps[picker]?.env?.MATRIX_DESKTOP_E2E_REQUIRED).toBe('1');
    expect(steps[picker]?.run).toBe('xvfb-run --auto-servernum bun run test:e2e:run -- tests/e2e/desktop/account-organization-picker.e2e.test.ts');
  });

  it('allows browser setup and general E2E execution to finish within the job budget', () => {
    // The current lane exhausted its old 15-minute budget after over 11 minutes
    // of browser setup, cancelling tests about 2.5 minutes into their execution.
    expect(workflow.jobs.e2e['timeout-minutes']).toBe(30);
  });

  it('retains frozen installs and keyed Next and browser caches', () => {
    expect(source).not.toContain('runs-on: ${{');
    expect(workflow.jobs['funded-postgres']['runs-on']).toBe('ubuntu-latest');
    expect(workflow.jobs['funded-host-root']['runs-on']).toBe('ubuntu-latest');
    for (const id of ['shell-production-build', 'e2e']) {
      const cache = workflow.jobs[id].steps.find(s => s.uses?.startsWith('actions/cache/restore@'));
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

  it('never saves caches from exact-source refresh dispatches', () => {
    // Refresh dispatches run in main's cache scope but check out a PR merge, so any cache they
    // save would be restored by trusted main runs.
    const outputs = (workflow.jobs.changes as Job & { outputs: Record<string, string> }).outputs;
    expect(outputs.cache_write).toBe("${{ (github.event_name == 'workflow_dispatch' && inputs.pr_number != '') && 'false' || 'true' }}");
    const gate = "needs.changes.outputs.cache_write == 'true'";
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps);
    expect(steps.some(s => s.uses?.startsWith('actions/cache@'))).toBe(false);
    const saves = steps.filter(s => s.uses?.startsWith('actions/cache/save@'));
    expect(saves).toHaveLength(2);
    for (const save of saves) expect(save.if).toContain(gate);
    const nodeCaches = steps.filter(s => s.uses?.startsWith('actions/setup-node@') && s.with?.cache !== undefined);
    expect(nodeCaches.length).toBeGreaterThan(0);
    for (const step of nodeCaches) expect(step.with?.cache).toBe(`\${{ ${gate} && 'pnpm' || '' }}`);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (!job.steps.some(s => s.uses?.startsWith('actions/cache/save@') || s.with?.cache !== undefined)) continue;
      expect([job.needs].flat(), id).toContain('changes');
    }
  });

  it('uploads shard-specific JSON profiling even after failing tests', () => {
    const steps = workflow.jobs.unit.steps;
    const test = steps.find(s => s.run?.startsWith('GITHUB_SHA="$UNIT_SOURCE_SHA" bun run test --'));
    expect(test?.run).toContain('--reporter=default --reporter=json');
    expect(test?.run).toContain('output/ci/unit-${{ matrix.shard }}.json');
    const upload = steps.find(s => s.name === 'Upload unit profiling');
    expect(upload?.if).toContain('always()');
    expect(upload?.with?.name).toBe('unit-profile-${{ matrix.shard }}');
    expect(upload?.with?.['retention-days']).toBe(7);
  });
});
