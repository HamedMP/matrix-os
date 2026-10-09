import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = resolve('scripts/ops/repair-funded-chat-config.py');
const roots: string[] = [];
const token = 'a'.repeat(64);
const identity = { machineId: 'example-machine', ownerId: 'user_example', handle: 'example-main', runtimeSlot: 'primary', epoch: 2 };
const original = '# preserved\nMATRIX_MACHINE_ID=example-machine\nMATRIX_CLERK_USER_ID=user_example\nMATRIX_HANDLE=example-main\nMATRIX_RUNTIME_SLOT=primary\nMATRIX_RUNTIME_TOKEN_EPOCH=2\nPLATFORM_INTERNAL_URL=https://platform.example.com\nUNRELATED="value $literal"\n';
const config = { relayUrl: 'https://relay.example.com/v1', runtimeToken: token };

function fixture(contents = original) {
  const root = mkdtempSync(join(tmpdir(), 'matrix-funding-repair-'));
  roots.push(root);
  chmodSync(root, 0o750);
  const path = join(root, 'host.env');
  writeFileSync(path, contents, { mode: 0o640 });
  return { root, path };
}

function expected(path: string) {
  const info = lstatSync(path);
  return { sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), inode: info.ino, device: info.dev };
}

function request(path: string, action = 'apply') {
  return { action, rolloutId: 'test-repair', identity, expectedFile: expected(path), quiescentWindow: true, ...(action === 'apply' ? { config } : {}) };
}

// Exercise real file descriptors/rename/fsync/flock with test-only directory and ownership injection.
function run(root: string, input: unknown, setup = '', activity = 'lambda: None', anchored = false) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', `
import importlib.util,json,os,sys
s=importlib.util.spec_from_file_location('repair',sys.argv[1]); m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=sys.argv[2]
${setup}
try:
 target=m.open_environment(root,os.getuid(),os.getgid()) if ${anchored ? 'True' : 'False'} else root
 print(json.dumps(m.execute(json.load(sys.stdin),target,os.getuid(),os.getgid(),${activity})))
except m.RepairError as e:
 print(json.dumps({'error':e.code}));sys.exit(1)
`, helper, root], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000 });
  expect(result.stderr).not.toContain('Traceback');
  if (result.status !== 0) expect(JSON.parse(result.stdout)).toHaveProperty('error');
  return result;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('operator funded Chat configuration repair', () => {
  function supported() {
    const base = fixture();
    const matrix = join(base.root, 'opt', 'matrix');
    const env = join(matrix, 'env');
    mkdirSync(join(base.root, 'opt'), { mode: 0o755 });
    mkdirSync(matrix, { mode: 0o770 });
    chmodSync(matrix, 0o770);
    mkdirSync(env, { mode: 0o750 });
    const path = join(env, 'host.env'); writeFileSync(path, original, { mode: 0o640 });
    return { root: base.root, matrix, env, path };
  }

  it('applies and rolls back through anchored provisioned 0770 matrix / 0750 env ancestors', () => {
    const { root, path } = supported();
    expect(run(root, request(path), '', 'lambda: None', true).status).toBe(0);
    expect(run(root, request(path, 'rollback'), '', 'lambda: None', true).status).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('rejects symlink ancestors and a group-writable target journal directory', () => {
    const a = supported(); chmodSync(a.env, 0o770);
    expect(run(a.root, request(a.path), '', 'lambda: None', true).status).toBe(1);
    const b = supported(); rmSync(b.env, { recursive: true }); symlinkSync(b.root, b.env);
    expect(run(b.root, request(join(b.root, 'host.env')), '', 'lambda: None', true).status).toBe(1);
  });

  it.each(['apply', 'rollback'])('refuses %s after an env ancestor is rebound without writing the replacement', action => {
    const { root, path } = supported();
    if (action === 'rollback') expect(run(root, request(path), '', 'lambda: None', true).status).toBe(0);
    const input = request(path, action);
    const before = readFileSync(path);
    const setup = `calls=0
def activity():
 global calls
 calls+=1
 if calls==2:
  os.rename(root+'/opt/matrix/env',root+'/opt/matrix/original-env')
  os.symlink(root,root+'/opt/matrix/env')`;
    expect(run(root, input, setup, 'activity', true).status).toBe(1);
    expect(readFileSync(join(root, 'host.env'), 'utf8')).toBe(original);
    expect(readFileSync(join(root, 'opt/matrix/original-env/host.env'))).toEqual(before);
  });

  it('detects a late rebind after the final check and confines a possibly committed write to the held protected directory', () => {
    const { root, path } = supported();
    const setup = `replace=m.os.replace
def rebound(*a,**kw):
 os.rename(root+'/opt/matrix/env',root+'/opt/matrix/original-env')
 os.symlink(root,root+'/opt/matrix/env')
 replace(*a,**kw)
m.os.replace=rebound`;
    expect(run(root, request(path), setup, 'lambda: None', true).status).toBe(1);
    expect(readFileSync(join(root, 'host.env'), 'utf8')).toBe(original);
    expect(readFileSync(join(root, 'opt/matrix/original-env/host.env'), 'utf8')).toContain('MATRIX_FUNDED_AI_ENABLED=true');
  });

  it('patches only funded keys with a private durable backup and redacted receipt', () => {
    const { root, path } = fixture();
    const result = run(root, request(path));
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(original + `MATRIX_FUNDED_AI_ENABLED=true\nMATRIX_FUNDED_AI_RELAY_URL=${config.relayUrl}\nMATRIX_FUNDED_AI_RUNTIME_TOKEN=${token}\n`);
    const receipt = JSON.parse(result.stdout);
    expect(receipt).toMatchObject({ changed: true, restartRequired: true, action: 'apply' });
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(lstatSync(path).mode & 0o777).toBe(0o640);
    expect(lstatSync(join(root, receipt.backup)).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('does not write, back up again or restart when desired state already matches', () => {
    const { root, path } = fixture();
    expect(run(root, request(path)).status).toBe(0);
    const before = expected(path);
    const result = run(root, request(path));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ changed: false, restartRequired: false });
    expect(expected(path)).toEqual(before);
  });

  it('restores exact original bytes when the post-image has not changed', () => {
    const { root, path } = fixture(original.trimEnd());
    expect(run(root, request(path)).status).toBe(0);
    const result = run(root, request(path, 'rollback'));
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(original.trimEnd());
    expect(JSON.parse(result.stdout)).toMatchObject({ changed: true, restartRequired: true });
    expect(run(root, request(path, 'rollback')).status).toBe(0);
  });

  it('rolls back affected keys while retaining later unrelated edits', () => {
    const { root, path } = fixture();
    expect(run(root, request(path)).status).toBe(0);
    writeFileSync(path, readFileSync(path, 'utf8').replace('# preserved', '# later edit') + 'ADDED=yes\n');
    expect(run(root, request(path, 'rollback')).status).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(original.replace('# preserved', '# later edit') + 'ADDED=yes\n');
  });

  it('keeps a newline boundary when restoring an originally unterminated managed line', () => {
    const contents = original + 'MATRIX_FUNDED_AI_RELAY_URL=https://old.example.com';
    const { root, path } = fixture(contents);
    expect(run(root, request(path)).status).toBe(0);
    writeFileSync(path, readFileSync(path, 'utf8') + 'LATER=yes\n');
    expect(run(root, request(path, 'rollback')).status).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(contents + '\nLATER=yes\n');
  });

  it('refuses rollback after an affected key changes', () => {
    const { root, path } = fixture();
    expect(run(root, request(path)).status).toBe(0);
    writeFileSync(path, readFileSync(path, 'utf8').replace(config.relayUrl, 'https://other.example.com'));
    const before = readFileSync(path);
    expect(run(root, request(path, 'rollback')).status).toBe(1);
    expect(readFileSync(path)).toEqual(before);
  });

  it('rejects corrupted rollback post-image metadata without touching the host', () => {
    const { root, path } = fixture();
    expect(run(root, request(path)).status).toBe(0);
    const journalPath = join(root, 'host.env.funded-test-repair.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.afterSha256 = '0'.repeat(64);
    writeFileSync(journalPath, JSON.stringify(journal));
    const before = readFileSync(path);
    expect(run(root, request(path, 'rollback')).status).toBe(1);
    expect(readFileSync(path)).toEqual(before);
  });

  it.each(['sha256', 'inode', 'device'] as const)('rejects stale expected %s', key => {
    const { root, path } = fixture();
    const input = request(path);
    input.expectedFile[key] = (key === 'sha256' ? '0'.repeat(64) : 0) as never;
    expect(run(root, input).status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.each(['epoch', 'machineId', 'ownerId', 'handle', 'runtimeSlot'] as const)('rejects wrong %s identity', key => {
    const { root, path } = fixture();
    const input = request(path);
    input.identity = { ...identity, [key]: key === 'epoch' ? 1 : 'other' };
    expect(run(root, input).status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.each(['MATRIX_FUNDED_AI_ENABLED=true\nMATRIX_FUNDED_AI_ENABLED=false\n', 'export MATRIX_MACHINE_ID=example-machine\n', ' MATRIX_FUNDED_AI_RELAY_URL=https://relay.example.com\n', 'MATRIX_FUNDED_AI_RUNTIME_TOKEN=$(touch /tmp/unsafe)\n'])('rejects ambiguous or executable managed syntax', extra => {
    const { root, path } = fixture(original + extra);
    expect(run(root, request(path)).status).toBe(1);
  });

  it('rejects symlinks, insecure permissions, hard links and oversized env files', () => {
    const a = fixture(); const input = request(a.path);
    const other = join(a.root, 'other'); writeFileSync(other, original);
    rmSync(a.path); symlinkSync(other, a.path);
    expect(run(a.root, input).status).toBe(1);
    const b = fixture(); chmodSync(b.path, 0o666);
    expect(run(b.root, request(b.path)).status).toBe(1);
    const c = fixture('x'.repeat(65_537));
    expect(run(c.root, request(c.path)).status).toBe(1);
    const d = fixture();
    expect(run(d.root, request(d.path), 'os.link(root+"/host.env",root+"/link")').status).toBe(1);
  });

  it.each([
    { quiescentWindow: false },
    { rolloutId: '../escape' },
    { config: { ...config, runtimeToken: 'invalid' } },
    { config: { ...config, relayUrl: 'https://eng107---relay.example.com' } },
    { config: { ...config, relayUrl: 'https://relay.example.com/?token=secret' } },
    { config: { ...config, relayUrl: 'https://127.0.0.1' } },
    { config: { ...config, platformUrl: 'https://platform.example.com/path' } },
    { config: { ...config, unrelatedKey: 'forbidden' } },
  ])('rejects invalid or unreviewed configuration %j', patch => {
    const { root, path } = fixture();
    expect(run(root, { ...request(path), ...patch }).status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('requires a valid effective Platform origin before enabling', () => {
    const { root, path } = fixture(original.replace('https://platform.example.com', ''));
    expect(run(root, request(path)).status).toBe(1);
    expect(run(root, { ...request(path), config: { ...config, platformUrl: 'https://platform.example.com' } }).status).toBe(0);
  });

  it('defers known writer activity and detects changes immediately before rename', () => {
    const { root, path } = fixture();
    expect(run(root, request(path), '', 'lambda: (_ for _ in ()).throw(m.RepairError("writer_busy"))').status).toBe(1);
    const setup = `calls=0
def activity():
 global calls
 calls+=1
 if calls==2:
  with open(root+'/host.env','ab') as f:f.write(b'NEW=value\\n')`;
    const result = run(root, request(path), setup, 'activity');
    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(original + 'NEW=value\n');
  });

  it('rejects busy repair locks and existing backup paths without reusing them', () => {
    const a = fixture();
    const lock = 'import fcntl\nfd=os.open(root+"/.host.env.funded-repair.lock",os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)';
    expect(run(a.root, request(a.path), lock).status).toBe(1);
    const b = fixture();
    writeFileSync(join(b.root, 'host.env.funded-test-repair.json'), '{}', { mode: 0o600 });
    expect(run(b.root, request(b.path)).status).toBe(1);
    expect(readFileSync(b.path, 'utf8')).toBe(original);
  });

  it('cleans up the temporary file and preserves original on failed rename', () => {
    const { root, path } = fixture();
    const result = run(root, request(path), 'def fail(*a,**kw):raise OSError("injected")\nm.os.replace=fail');
    expect(result.status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(root).filter(name => name.includes('.tmp-'))).toEqual([]);
    expect(existsSync(join(root, 'host.env.funded-test-repair.json'))).toBe(true);
  });

  it('removes its partially written temporary file when fsync fails', () => {
    const { root, path } = fixture();
    const setup = `calls=0
real_fsync=m.os.fsync
def fail(fd):
 global calls
 calls+=1
 if calls==3:raise OSError('injected')
 real_fsync(fd)
m.os.fsync=fail`;
    expect(run(root, request(path), setup).status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(root).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
});
