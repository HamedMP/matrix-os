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
  it('installs browsers on a pinned Ubuntu release supported by the locked Playwright toolchain', () => {
    // Playwright 1.60.0 rejects Ubuntu 26.04 during dependency installation.
    // Keep both real browser-install steps and the full E2E matrix on a stable
    // supported image instead of allowing ubuntu-latest to change underneath it.
    const browserJobs = Object.values(workflow.jobs).filter(job =>
      job.steps.some(step => step.run?.includes('playwright install')),
    );
    expect(browserJobs).toContain(workflow.jobs.e2e);
    for (const job of browserJobs) expect(['ubuntu-22.04', 'ubuntu-24.04']).toContain(job['runs-on']);
  });

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

  it('starts every lane right after classification so lanes run in parallel', () => {
    for (const id of ['unit', 'e2e', 'shell-production-build', 'sync-client', 'typecheck']) {
      expect(workflow.jobs[id].needs, id).toBe('changes');
    }
    const gate = workflow.jobs['ci-results'];
    for (const id of ['unit', 'e2e', 'sync-client', 'shell-production-build', 'funded-postgres', 'funded-host-root']) {
      expect(gate.needs).toContain(id);
    }
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
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

  it('keeps Playwright E2E on a supported hosted Ubuntu image', () => {
    // Playwright 1.60 rejects Chromium installation on the Ubuntu 26.04 image
    // currently selected by ubuntu-latest, so this lane must remain explicit.
    expect(workflow.jobs.e2e['runs-on']).toBe('ubuntu-24.04');
  });

  it('builds node-pty from source before E2E prerequisites', () => {
    const steps = workflow.jobs.e2e.steps;
    const install = steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile');
    const rebuild = steps.findIndex(step => step.run === 'node scripts/build-node-pty.mjs');
    const prepare = steps.findIndex(step => step.run === 'bun run test:prepare');

    expect(rebuild).toBeGreaterThan(install);
    expect(rebuild).toBeLessThan(prepare);

    const builder = readFileSync(join(process.cwd(), 'scripts/build-node-pty.mjs'), 'utf8');
    expect(builder).toContain("require.resolve('node-gyp/bin/node-gyp.js'");
    expect(builder).toContain("join(nodePtyRoot, 'build', 'Release', 'pty.node')");
    expect(builder).toContain("require('node-pty')");
    expect(builder).toContain('} catch (error) {');
    expect(builder).toContain('error instanceof Error ? error.stack ?? error.message : error');
  });

  it('retains frozen installs and keyed Next and browser caches', () => {
    // Only the unit shards are routed (to the runner pool); every other lane is pinned.
    expect(source.match(/runs-on: \$\{\{/g)).toHaveLength(1);
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

  it('saves caches only after a cache miss, from the run that produced them', () => {
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps);
    expect(steps.some(s => s.uses?.startsWith('actions/cache@'))).toBe(false);
    const saves = steps.filter(s => s.uses?.startsWith('actions/cache/save@'));
    expect(saves).toHaveLength(2);
    for (const save of saves) expect(save.if).toMatch(/cache-hit != 'true'/);
    const nodeCaches = steps.filter(s => s.uses?.startsWith('actions/setup-node@') && s.with?.cache !== undefined);
    expect(nodeCaches.length).toBeGreaterThan(0);
    for (const step of nodeCaches) expect(step.with?.cache).toBe('pnpm');
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

describe('Docker image export runner capacity', () => {
  it('frees unused hosted tools before building the image and retains artifact integrity checks', () => {
    const docker = parse(readFileSync('.github/workflows/docker-test.yml', 'utf8')).jobs['docker-build'];
    const cleanup = docker.steps.findIndex((step: {name?: string}) => step.name === 'Free runner disk before Docker build');
    const build = docker.steps.findIndex((step: {uses?: string}) => step.uses?.startsWith('docker/build-push-action@'));
    const save = docker.steps.findIndex((step: {name?: string}) => step.name === 'Save Docker image artifact');
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeLessThan(build);
    expect(build).toBeLessThan(save);
    expect(docker.steps[cleanup].if).toBe(docker.if);
    expect(docker.steps[cleanup].run).toContain('sudo rm -rf ');
    expect(docker.steps[cleanup].run).not.toMatch(/\/tmp\/matrix-os|hostedtoolcache\/node|docker system prune/);
    expect(docker.steps[build].with.outputs).toBe('type=docker,dest=${{ runner.temp }}/matrix-os-dev-ci.tar');
    expect(docker.steps[build].with['cache-to']).toContain('type=gha,mode=max');
    const prune = docker.steps[save].run.indexOf('docker buildx prune --all --force');
    expect(prune).toBeGreaterThanOrEqual(0);
    expect(prune).toBeLessThan(docker.steps[save].run.indexOf('gzip -1 <'));
    expect(docker.steps[save].run).toContain('df -h "$RUNNER_TEMP"');
    expect(readFileSync('.github/workflows/docker-test.yml', 'utf8')).not.toMatch(/\/tmp\/(?:matrix-os-dev-ci|docker-image)/);
    expect(docker.steps[save].run).toContain('gzip -t "$RUNNER_TEMP/matrix-os-dev-ci.tar.gz"');
    expect(docker.steps[save].run).toContain('test "$(stat -c%s "$RUNNER_TEMP/matrix-os-dev-ci.tar.gz")" -gt 1000000');
  });
});
