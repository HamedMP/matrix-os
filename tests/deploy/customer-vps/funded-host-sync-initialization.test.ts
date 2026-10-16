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
    // Inspect executable loader arguments, including the embedded repair program,
    // rather than matching unrelated words inside its serialized source literal.
    const syntax = spawnSync('python3', ['-I', '-c', `
import ast, sys
loaders = {'run_path', 'run_module', 'spec_from_file_location', 'SourceFileLoader',
           'SourcelessFileLoader', 'load_source', 'exec', 'eval', 'compile', '__import__', 'import_module'}
def assert_self_contained(source):
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'REPAIR_SOURCE' for target in node.targets):
            assert_self_contained(ast.literal_eval(node.value))
        if not isinstance(node, ast.Call):
            continue
        name = ast.unparse(node.func)
        if name.rsplit('.', 1)[-1] in loaders or name.startswith('sys.path.'):
            assert not any(isinstance(value, ast.Constant) and isinstance(value.value, str)
                           and '/opt/matrix/app' in value.value for value in ast.walk(node)), name
source = sys.stdin.read()
compile(source, '<protected>', 'exec')
assert_self_contained(source)
`], {
      input: program, encoding: 'utf8', timeout: 10_000,
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });
});
