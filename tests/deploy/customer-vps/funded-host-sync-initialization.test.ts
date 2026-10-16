import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('trusted Sync initialization composition', () => {
  it('executes real protected-file regressions without customer operations', () => {
    const result = spawnSync('python3', ['-I', 'tests/deploy/customer-vps/funded-host-sync-initialization.test.py'], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9]\d* test/);
    expect(result.stderr).toMatch(/\nOK\s*$/);
    expect(result.stderr).not.toContain('skipped=');
  });

  it('includes explicit root-only initialization in the verified self-contained component', () => {
    const root = mkdtempSync(join(tmpdir(), 'matrix-sync-init-component-')); roots.push(root);
    const agent = join(root, 'agent'); copyFileSync('distro/customer-vps/host-bin/matrix-sync-agent', agent);
    const generated = spawnSync(process.execPath, ['scripts/prepare-funded-host-component.mjs', agent, join(root, 'component')], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(generated.status, generated.stderr).toBe(0);
    const program = readFileSync(join(root, 'component', 'reconcile.py'), 'utf8');
    expect(program).toContain('def initialize_scoped_sync(');
    expect(program).toContain("'--initialize-sync'");
    expect(program).not.toMatch(/(?:import|run_path).*\/opt\/matrix\/app/);
    const syntax = spawnSync('python3', ['-I', '-c', 'import sys;compile(sys.stdin.read(),"<protected>","exec")'], {
      input: program, encoding: 'utf8', timeout: 10_000,
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });
});
