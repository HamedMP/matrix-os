import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const launcher = resolve('scripts/ops/launch-funded-config-repair.py');
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'matrix-funding-launch-')); roots.push(root); chmodSync(root, 0o750);
  for (const [name, mode] of [['opt', 0o755], ['opt/matrix', 0o770], ['opt/matrix/env', 0o750], ['opt/matrix/runtime', 0o755], ['opt/matrix/runtime/node', 0o755], ['opt/matrix/runtime/node/bin', 0o2775]] as const) {
    mkdirSync(join(root, name), { mode }); chmodSync(join(root, name), mode);
  }
  writeFileSync(join(root, 'opt/matrix/env/host.env'), 'MATRIX_AUTH_TOKEN=' + 'a'.repeat(64) + '\n', { mode: 0o640 });
  const node = join(root, 'opt/matrix/runtime/node/bin/node');
  copyFileSync(process.execPath, node); chmodSync(node, 0o775);
  // Test provenance comes from our running interpreter, independently of the fixture copy.
  return { root, node, hash: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') };
}
function run(root: string, body: string) {
  return spawnSync('/usr/bin/python3', ['-I', '-c', `import importlib.util,os,sys,json
s=importlib.util.spec_from_file_location('launch',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=sys.argv[2]
try:
 ${body}
except (ValueError,OSError) as e:
 print(json.dumps({'error':str(e)}));sys.exit(1)
`, launcher, root], { encoding: 'utf8', timeout: 15_000 });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('trusted repair interpreter launcher', () => {
  it('anchors the provisioned layout and rejects symlinks or writable env directories', () => {
    const { root } = fixture();
    const body = `fds=m.open_chain(root,('opt','matrix','env'),os.getuid(),os.getgid());print('opened')`;
    expect(run(root, body).status).toBe(0);
    chmodSync(join(root, 'opt/matrix/env'), 0o770);
    expect(run(root, body).status).toBe(1);
    rmSync(join(root, 'opt/matrix/env'), { recursive: true }); symlinkSync(root, join(root, 'opt/matrix/env'));
    expect(run(root, body).status).toBe(1);
  });

  it('rejects replaced writable runtime bytes against an independent pinned digest', () => {
    const { root, node, hash } = fixture();
    writeFileSync(node, 'untrusted interpreter');
    const result = run(root, `fd=os.open(root+'/opt/matrix/runtime/node/bin/node',os.O_RDONLY);m.snapshot_node(fd,'${hash}');print('unexpected')`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('digest');
  });

  it('rejects canonical ancestor rebinding while keeping original env descriptor pinned', () => {
    const { root } = fixture();
    const result = run(root, `fds=m.open_chain(root,('opt','matrix','env'),os.getuid(),os.getgid())
 os.rename(root+'/opt/matrix/env',root+'/opt/matrix/old-env');os.symlink(root,root+'/opt/matrix/env')
 m.verify_chain(fds,('opt','matrix','env'),os.getuid(),os.getgid());print('unexpected')`);
    expect(result.status).toBe(1);
  });

  it.runIf(process.platform === 'linux')('executes immutable sealed bytes with explicit directory descriptors and a sanitized environment', () => {
    const { root, hash } = fixture();
    const result = run(root, `fds=m.open_chain(root,('opt','matrix','env'),os.getuid(),os.getgid())
 fd=os.open(root+'/opt/matrix/runtime/node/bin/node',os.O_RDONLY)
 sealed=m.snapshot_node(fd,'${hash}')
 try:os.write(sealed,b'changed');raise ValueError('seal ineffective')
 except PermissionError:pass
 m.inherit_environment(fds,os.open('host.env',os.O_RDONLY,dir_fd=fds[-1]))
 os.environ['NODE_OPTIONS']='--require=/untrusted'
 os.execve(sealed,['node','-e',"const f=require('node:fs');console.log(JSON.stringify({env:f.fstatSync(3).isDirectory(),host:f.fstatSync(4).isFile(),clean:!process.env.NODE_OPTIONS&&!process.env.NODE_PATH}))"],m.clean_environment())`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ env: true, host: true, clean: true });
  });
});
