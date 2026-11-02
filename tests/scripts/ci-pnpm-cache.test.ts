import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const yaml = (file: string) => parse(readFileSync(file, 'utf8'));
const ci = yaml('.github/workflows/ci.yml');
type Step = { name?: string; uses?: string; if?: string; run?: string; with?: Record<string, unknown> };

describe('pnpm cache reuse without refresh writes', () => {
  it('restores the store before every refresh install while keeping setup-node saves gated', () => {
    const lanes = Object.values(ci.jobs).filter((job: any) => job.steps.some((s: Step) =>
      s.uses?.startsWith('actions/setup-node@') && s.with?.cache !== undefined));
    expect(lanes.length).toBeGreaterThan(0);
    for (const job of lanes as { steps: Step[] }[]) {
      const setup = job.steps.findIndex(s => s.uses?.startsWith('actions/setup-node@'));
      const restore = job.steps.findIndex(s => s.uses === './.github/actions/restore-pnpm-store');
      const install = job.steps.findIndex(s => s.run === 'pnpm install --frozen-lockfile');
      expect(restore).toBeGreaterThan(setup);
      expect(restore).toBeLessThan(install);
      expect(job.steps[restore].if).toBe("needs.changes.outputs.should_run == 'true' && needs.changes.outputs.cache_write == 'false'");
      expect(job.steps[setup].with?.cache).toBe("${{ needs.changes.outputs.cache_write == 'true' && 'pnpm' || '' }}");
    }
  });

  it('uses setup-node compatible exact keys and a restore-only action', () => {
    const action = yaml('.github/actions/restore-pnpm-store/action.yml');
    expect(action.runs.using).toBe('composite');
    const restores = action.runs.steps.filter((s: Step) => s.uses);
    expect(restores).toHaveLength(1);
    expect(restores[0].uses).toBe('actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830');
    expect(restores[0].with).toEqual({
      path: '${{ steps.store.outputs.path }}',
      key: "node-cache-${{ runner.os }}-${{ steps.store.outputs.arch }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
    });
  });

  it('discovers the actual pnpm store and Node architecture used by setup-node', () => {
    const action = yaml('.github/actions/restore-pnpm-store/action.yml');
    const step = action.runs.steps.find((s: any) => s.id === 'store');
    const dir = mkdtempSync(join(tmpdir(), 'matrix-cache-path-'));
    const output = join(dir, 'outputs');
    try {
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], { env: { ...process.env, GITHUB_OUTPUT: output } });
      const expected = execFileSync('pnpm', ['store', 'path', '--silent'], { encoding: 'utf8' }).trim();
      expect(readFileSync(output, 'utf8')).toBe(`path=${expected}\narch=${process.arch}\n`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('seeds independently on main and schedule without executing dependency scripts', () => {
    const seed = yaml('.github/workflows/pnpm-cache.yml');
    expect(seed.on.push).toEqual({ branches: ['main'] });
    expect(seed.on.schedule).toHaveLength(1);
    expect(Object.keys(seed.on).sort()).toEqual(['push', 'schedule']);
    expect(seed.permissions).toEqual({ contents: 'read' });
    expect(seed.jobs.seed.if).toBe("github.ref == 'refs/heads/main'");
    expect(seed.jobs.seed['timeout-minutes']).toBe(10);
    const steps = seed.jobs.seed.steps as Step[];
    expect(steps.find(s => s.uses?.startsWith('actions/checkout@'))?.with?.['persist-credentials']).toBe(false);
    expect(steps.find(s => s.uses?.startsWith('pnpm/action-setup@'))?.with?.version).toBe('10.33.4');
    expect(steps.find(s => s.uses?.startsWith('actions/setup-node@'))?.with).toEqual({ 'node-version': 24, cache: 'pnpm' });
    expect(steps.filter(s => s.run).map(s => s.run)).toEqual(['pnpm install --frozen-lockfile --ignore-scripts']);
    expect(steps.find(s => s.run)?.if).toBe("steps.node.outputs.cache-hit != 'true'");
    expect(steps.find(s => s.uses?.startsWith('actions/checkout@'))?.with?.ref).toBeUndefined();
  });
});
