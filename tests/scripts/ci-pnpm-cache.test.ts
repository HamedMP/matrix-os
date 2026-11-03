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
      const restore = job.steps.findIndex(s => s.name === 'Restore exact dependency cache');
      const install = job.steps.findIndex(s => s.run === 'pnpm install --frozen-lockfile');
      expect(restore).toBeGreaterThan(setup);
      expect(restore).toBeLessThan(install);
      expect(job.steps[restore].if).toBe("needs.changes.outputs.cache_write == 'false'");
      expect(job.steps[restore].uses).toBe('actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830');
      expect(job.steps[restore - 1].name).toBe('Locate pnpm store for read-only refresh');
      expect(job.steps[restore - 1].if).toBe(job.steps[restore].if);
      expect(job.steps[setup].with?.cache).toBe("${{ needs.changes.outputs.cache_write == 'true' && 'pnpm' || '' }}");
    }
  });

  it.each(['docs-contract', 'os-view-parity'])('restores %s dependencies when source lanes are intentionally skipped', id => {
    const steps = ci.jobs[id].steps as Step[];
    const restore = steps.find(s => s.name === 'Restore exact dependency cache')!;
    const needs = { changes: { outputs: { should_run: 'false', cache_write: 'false' } } };
    // Execute the real workflow guard; this job already owns docs/fallback admission.
    expect(Function('needs', `return (${restore.if});`)(needs)).toBe(true);
  });

  it('uses setup-node compatible exact keys and a restore-only action', () => {
    const restores = ci.jobs.typecheck.steps.filter((s: Step) => s.name === 'Restore exact dependency cache');
    expect(restores).toHaveLength(1);
    expect(restores[0].uses).toBe('actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830');
    expect(restores[0].with).toEqual({
      path: '${{ steps.refresh-store.outputs.path }}',
      key: "node-cache-${{ runner.os }}-${{ steps.refresh-store.outputs.arch }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
    });
  });

  it('runs workflow-owned store discovery even when the tested source has no new local action', () => {
    const step = ci.jobs.typecheck.steps.find((s: any) => s.id === 'refresh-store');
    const dir = mkdtempSync(join(tmpdir(), 'matrix-cache-path-'));
    const output = join(dir, 'outputs');
    try {
      // A historical source need not contain any .github/actions helper.
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: output } });
      const expected = execFileSync('pnpm', ['store', 'path', '--silent'], { cwd: dir, encoding: 'utf8' }).trim();
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
