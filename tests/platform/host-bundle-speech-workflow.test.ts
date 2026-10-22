import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/host-bundle-release.yml'), 'utf8'));

describe('host bundle speech activation scheduling', () => {
  it('gives activation its own runner and bounded budget after either deployment path', () => {
    const activation = workflow.jobs['activate-speech'];
    expect(activation).toBeDefined();
    expect(activation.needs).toEqual(['deploy', 'targeted-deploy']);
    expect(activation['timeout-minutes']).toBeGreaterThanOrEqual(46);
    expect(activation.steps).toContainEqual(expect.objectContaining({
      run: 'node scripts/ci/targeted-fleet-maintenance.mjs activate-managed-features',
    }));
    expect(activation.steps).toContainEqual(expect.objectContaining({ uses: 'actions/checkout@v4' }));
    expect(workflow.jobs.deploy['continue-on-error']).toBeUndefined();
  });

  it.each([
    ['success', 'skipped', 'true', false, true],
    ['failure', 'skipped', 'true', false, true],
    ['skipped', 'success', 'true', false, true],
    ['skipped', 'failure', 'true', false, true],
    ['skipped', 'skipped', 'true', false, false],
    ['failure', 'skipped', 'false', false, true],
    ['failure', 'skipped', 'true', true, false],
    ['cancelled', 'skipped', 'true', false, true],
    ['cancelled', 'skipped', 'true', true, false],
  ])('schedules after deploy=%s targeted=%s enabled=%s cancelled=%s', (deploy, targeted, enabled, cancelled, expected) => {
    const activation = workflow.jobs['activate-speech'];
    expect(activation).toBeDefined();
    const expression = activation.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    // GitHub adds success() unless a status function is explicit. Model that
    // default so a plain flag condition cannot regress to skipping on failure.
    const statusGuard = /\b(?:always|cancelled|success|failure)\s*\(/.test(expression)
      ? '' : 'success() && ';
    const evaluate = new Function('needs', 'vars', 'cancelled', 'success', `return ${statusGuard}${expression}`);
    expect(evaluate(
      { deploy: { result: deploy }, 'targeted-deploy': { result: targeted } },
      { MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED: enabled },
      () => cancelled,
      () => deploy === 'success' && targeted === 'success',
    )).toBe(expected);
  });
});
