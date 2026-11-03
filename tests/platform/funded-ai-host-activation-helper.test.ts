import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
const helper = fileURLToPath(new URL('../../distro/customer-vps/host-bin/matrix-configure-funded-ai.py', import.meta.url));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const request = { contractVersion: 1, identity: { handle: 'alice', machineId: 'machine-1', ownerId: 'user_1', runtimeSlot: 'primary', runtimeTokenEpoch: 2 }, configuration: { enabled: true, platformOrigin: 'https://app.matrix-os.com', relayOrigin: 'https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app', runtimeToken: 'a'.repeat(64) } };
const original = '# preserve bytes\r\nMATRIX_HANDLE=alice\nMATRIX_MACHINE_ID=machine-1\nMATRIX_CLERK_USER_ID=user_1\nMATRIX_RUNTIME_SLOT=primary\nOTHER_SETTING="keep exact"\nMATRIX_FUNDED_AI_ENABLED=false\n';
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'matrix-funded-activation-')); dirs.push(dir); const envPath = join(dir, 'host.env'); await writeFile(envPath, original, { mode: 0o640 }); return { dir, envPath }; }
function apply(envPath: string, body: unknown = request, extra = '', markers: string[] = []) {
  const now = new Date();
  const proof = { ...body as object, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30000).toISOString() };
  return spawnSync('python3', ['-c', `import json,runpy,sys,os\nm=runpy.run_path(sys.argv[1],run_name='test_helper')\n${extra}\nm['apply_config'](sys.argv[2],json.loads(sys.stdin.read()),markers=json.loads(sys.argv[3]))`, helper, envPath, JSON.stringify(markers)], { encoding: 'utf8', input: JSON.stringify(proof) });
}
describe('funded AI host configuration primitive', () => {
  it('activates trailing-hyphen handles accepted by platform provisioning', async () => {
    const f = await fixture();
    await writeFile(f.envPath, original.replace('MATRIX_HANDLE=alice', 'MATRIX_HANDLE=alice-'));
    const result = apply(f.envPath, { ...request, identity: { ...request.identity, handle: 'alice-' } });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(f.envPath, 'utf8')).toContain('MATRIX_FUNDED_AI_ENABLED=true');
  });
  it('installs an exact non-primary Preview proof without relaxing local identity checks', async () => {
    const f = await fixture();
    const previewSlot = 'pr-2383';
    const previewRequest = { ...request, identity: { ...request.identity,
      handle: previewSlot, runtimeSlot: previewSlot } };
    await writeFile(f.envPath, original
      .replace('MATRIX_HANDLE=alice', `MATRIX_HANDLE=${previewSlot}`)
      .replace('MATRIX_RUNTIME_SLOT=primary', `MATRIX_RUNTIME_SLOT=${previewSlot}`));
    const result = apply(f.envPath, previewRequest);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(f.envPath, 'utf8')).toContain('MATRIX_FUNDED_AI_ENABLED=true');
  });
  it('initializes absent authoritative epoch and changes only five managed assignments atomically', async () => {
    const f = await fixture();
    expect(apply(f.envPath).status).toBe(0);
    const updated = await readFile(f.envPath, 'utf8');
    expect(updated).toContain(original.replace('MATRIX_FUNDED_AI_ENABLED=false', 'MATRIX_FUNDED_AI_ENABLED=true'));
    expect(updated).toContain('MATRIX_RUNTIME_TOKEN_EPOCH=2\n');
    expect(updated).toContain('MATRIX_FUNDED_AI_PLATFORM_URL=https://app.matrix-os.com\n');
    expect(updated).toContain('MATRIX_FUNDED_AI_RUNTIME_TOKEN=' + request.configuration.runtimeToken + '\n');
    const backups = (await readdir(f.dir)).filter(name => name.startsWith('host.env.pre-funded-ai-'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(f.dir, backups[0]), 'utf8')).toBe(original);
    expect((await stat(f.envPath)).mode & 0o777).toBe(0o640);
    const inode = (await stat(f.envPath)).ino;
    expect(apply(f.envPath).status).toBe(0);
    expect((await stat(f.envPath)).ino).toBe(inode);
    expect((await readdir(f.dir)).filter(n => n.startsWith('.host.env.funded-ai-'))).toEqual([]);
  });
  it.each([
    { identity: { ...request.identity, machineId: 'other' } }, { identity: { ...request.identity, ownerId: 'other' } }, { identity: { ...request.identity, handle: 'bob' } }, { identity: { ...request.identity, runtimeSlot: 'secondary' } },
    { configuration: { ...request.configuration, relayOrigin: 'https://evil.test' } }, { configuration: { ...request.configuration, enabled: false } }, { configuration: { ...request.configuration, runtimeToken: 'bad' } }, { extra: true },
  ])('rejects malformed and mismatched identity/configuration without mutation %j', async (extra) => { const f = await fixture(); expect(apply(f.envPath, { ...request, ...extra }).status).not.toBe(0); expect(await readFile(f.envPath, 'utf8')).toBe(original); });
  it('rejects present differing epoch, duplicate assignments, exported overrides and custom origins', async () => {
    for (const suffix of ['MATRIX_RUNTIME_TOKEN_EPOCH=1\n', 'MATRIX_MACHINE_ID=machine-1\n', 'export MATRIX_FUNDED_AI_ENABLED=false\n', 'MATRIX_FUNDED_AI_PLATFORM_URL=https://custom.test\n', 'MATRIX_FUNDED_AI_RELAY_URL=https://custom.test\n']) {
      const f = await fixture();
      await writeFile(f.envPath, original + suffix);
      expect(apply(f.envPath).status).not.toBe(0);
      expect(await readFile(f.envPath, 'utf8')).toBe(original + suffix);
    }
  });
  it('rejects stale policy proof', async () => {
    const f = await fixture();
    expect(apply(f.envPath, request, "m['apply_config'].__globals__['time'].time=lambda:0").status).not.toBe(0);
    expect(await readFile(f.envPath, 'utf8')).toBe(original);
  });
  it('rejects symlinked environment and lock without modifying the target', async () => {
    const f = await fixture();
    const alias = join(f.dir, 'link.env');
    await symlink(f.envPath, alias);
    expect(apply(alias).status).not.toBe(0);
    await rm(join(f.dir, '.host.env.funded-repair.lock'));
    await symlink(f.envPath, join(f.dir, '.host.env.funded-repair.lock'));
    expect(apply(f.envPath).status).not.toBe(0);
    expect(await readFile(f.envPath, 'utf8')).toBe(original);
  });
  it('rejects concurrent environment changes at the final compare-and-swap check', async () => {
    const f = await fixture();
    const patch = "real=m['apply_config'].__globals__['write_backup']\ndef race(*args):\n real(*args)\n with open(sys.argv[2],'ab') as out:out.write(b'CONCURRENT=keep\\n')\nm['apply_config'].__globals__['write_backup']=race";
    expect(apply(f.envPath, request, patch).status).not.toBe(0);
    expect(await readFile(f.envPath, 'utf8')).toBe(original + 'CONCURRENT=keep\n');
    expect((await readdir(f.dir)).filter(n => n.startsWith('.host.env.funded-ai-'))).toEqual([]);
  });
  it('does not overwrite exclusive backups and caps regular backups without following symlinks', async () => {
    const f = await fixture();
    for (let i = 0; i < 7; i++)
      await writeFile(join(f.dir, `host.env.pre-funded-ai-${i}`), 'old', { mode: 0o600 });
    const target = join(f.dir, 'protected');
    await writeFile(target, 'preserved');
    await symlink(target, join(f.dir, 'host.env.pre-funded-ai-link'));
    expect(apply(f.envPath).status).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('preserved');
    const regular = [];
    for (const n of await readdir(f.dir))
      if (n.startsWith('host.env.pre-funded-ai-') && !(n.endsWith('link')))
        regular.push(n);
    expect(regular.length).toBeLessThanOrEqual(5);
  });
  it('rejects active updater and rotation markers before writing', async () => {
    const f = await fixture();
    const marker = join(f.dir, 'busy');
    await mkdir(marker);
    const result = spawnSync('python3', ['-c', "import json,runpy,sys; m=runpy.run_path(sys.argv[1]);m['apply_config'](sys.argv[2],json.loads(sys.stdin.read()),markers=(sys.argv[3],))", helper, f.envPath, marker], { encoding: 'utf8', input: JSON.stringify({ ...request, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString() }) });
    expect(result.status).not.toBe(0);
    expect(await readFile(f.envPath, 'utf8')).toBe(original);
  });
  it('serializes on the existing funded-repair writer lock', async () => {
    const f = await fixture();
    const patch = "import fcntl\nheld=os.open(os.path.join(os.path.dirname(sys.argv[2]),'.host.env.funded-repair.lock'),os.O_RDWR|os.O_CREAT,0o600)\nfcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)";
    expect(apply(f.envPath, request, patch).status).not.toBe(0);
    expect(await readFile(f.envPath, 'utf8')).toBe(original);
  });
});
describe('shared host environment writer serialization', () => {
  it.each(['matrix-configure-platform-speech.py', 'matrix-rotate-runtime-tokens.py'])('prevents %s racing funded activation', async (name) => {
    const f = await fixture();
    const source = fileURLToPath(new URL(`../../distro/customer-vps/host-bin/${name}`, import.meta.url));
    const program = ["import fcntl,os,runpy,sys", "m=runpy.run_path(sys.argv[1],run_name='writer_test')", "fd=os.open(os.path.join(os.path.dirname(sys.argv[2]),'.host.env.funded-repair.lock'),os.O_RDWR|os.O_CREAT,0o600)", "fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)", "try:", name.includes('speech') ? " m['apply_config'](sys.argv[2],sys.argv[2]+'.backup',{'machineId':'machine-1','runtimeSlot':'primary','enabled':True,'origin':'https://app.matrix-os.com','runtimeToken':'a'*64})" : " m['apply_rotation'](sys.argv[2],'/missing-key','/missing-envelope')", "except BlockingIOError:", " sys.exit(0)", "except Exception:", " sys.exit(2)", "sys.exit(1)"].join('\n');
    const result = spawnSync('python3', ['-c', program, source, f.envPath], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(f.envPath, 'utf8')).toBe(original);
  });
});


async function retainedUpdateFixture() {
  const f = await fixture(), transaction = join(f.dir, 'staging', 'update-transaction');
  await mkdir(transaction, { recursive: true }); await mkdir(join(f.dir, 'app'));
  await writeFile(join(transaction, 'state'), 'mutating\n', { mode: 0o644 });
  await writeFile(join(transaction, 'candidate-version'), 'v2026.10.18-1\n', { mode: 0o644 });
  await writeFile(join(f.dir, 'release.json'), JSON.stringify({ version: 'v2026.10.18-1' }), { mode: 0o644 });
  await writeFile(join(f.dir, 'app', 'BUNDLE_VERSION'), 'v2026.10.18-1\n', { mode: 0o644 });
  return { ...f, transaction };
}
describe('completed host maintenance records', () => {
  it('allows retained successful updater rollback state and preserves it byte-for-byte', async () => {
    const f = await retainedUpdateFixture();
    const result = apply(f.envPath, request, '', [f.transaction]);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(f.transaction, 'state'), 'utf8')).toBe('mutating\n');
    expect(await readFile(join(f.transaction, 'candidate-version'), 'utf8')).toBe('v2026.10.18-1\n');
  });
  it.each(['prepared', 'unknown', 'wrong_version', 'same_version_repair', 'symlink_state', 'symlink_directory', 'active_phase'])(
    'rejects unfinished or unsafe updater state: %s', async state => {
      const f = await retainedUpdateFixture();
      let marker = f.transaction;
      if (state === 'prepared' || state === 'unknown') await writeFile(join(marker, 'state'), state + '\n');
      if (state === 'wrong_version') await writeFile(join(f.dir, 'release.json'), JSON.stringify({ version: 'older' }));
      if (state === 'same_version_repair') await writeFile(join(marker, 'same-version-repair.json'), '{}');
      if (state === 'symlink_state') { await rm(join(marker, 'state')); await symlink(f.envPath, join(marker, 'state')); }
      if (state === 'symlink_directory') { marker = join(f.dir, 'update-transaction'); await symlink(f.transaction, marker); }
      const markers = [marker];
      if (state === 'active_phase') { const phase = join(f.dir, 'staging', 'update-phase'); await writeFile(phase, 'health\n'); markers.push(phase); }
      expect(apply(f.envPath, request, '', markers).status).not.toBe(0);
      expect(await readFile(f.envPath, 'utf8')).toBe(original);
    });
  it('allows a retained completed funded repair after-image without rewriting its record', async () => {
    const f = await fixture(); expect(apply(f.envPath).status).toBe(0);
    const after = await readFile(f.envPath); const applied = join(f.dir, 'applied.json');
    const record = JSON.stringify({ rolloutId: 'repair-' + 'a'.repeat(32), identity: { handle: 'alice', machineId: 'machine-1', ownerId: 'user_1', runtimeSlot: 'primary', epoch: 2 }, afterSha256: createHash('sha256').update(after).digest('hex') });
    await writeFile(applied, record, { mode: 0o600 });
    expect(apply(f.envPath, request, '', [applied]).status).toBe(0);
    expect(await readFile(applied, 'utf8')).toBe(record); expect(await readFile(f.envPath)).toEqual(after);
  });
  it.each(['speech', 'rotation'])('allows completed repair history after later legitimate %s configuration changes', async change => {
    const f = await fixture(); expect(apply(f.envPath).status).toBe(0);
    const before = await readFile(f.envPath, 'utf8'); const applied = join(f.dir, 'applied.json');
    const record = JSON.stringify({ rolloutId: 'repair-' + 'a'.repeat(32), identity: { handle: 'alice', machineId: 'machine-1', ownerId: 'user_1', runtimeSlot: 'primary', epoch: 2 }, afterSha256: createHash('sha256').update(before).digest('hex') });
    await writeFile(applied, record, { mode: 0o600 });
    const next = change === 'speech' ? before + 'MATRIX_PLATFORM_SPEECH_ENABLED=true\n' : before.replace('MATRIX_RUNTIME_TOKEN_EPOCH=2', 'MATRIX_RUNTIME_TOKEN_EPOCH=3').replace('MATRIX_FUNDED_AI_RUNTIME_TOKEN=' + 'a'.repeat(64), 'MATRIX_FUNDED_AI_RUNTIME_TOKEN=' + 'b'.repeat(64));
    await writeFile(f.envPath, next);
    const body = change === 'speech' ? request : { ...request, identity: { ...request.identity, runtimeTokenEpoch: 3 }, configuration: { ...request.configuration, runtimeToken: 'b'.repeat(64) } };
    const result = apply(f.envPath, body, '', [applied]); expect(result.status, result.stderr).toBe(0);
    expect(await readFile(applied, 'utf8')).toBe(record); expect(await readFile(f.envPath, 'utf8')).toBe(next);
  });
  it.each(['incomplete', 'invalid_hash', 'wrong_identity', 'future_epoch', 'malformed', 'symlink'])(
    'rejects unfinished or unsafe funded repair records: %s', async state => {
      const f = await fixture(); const applied = join(f.dir, 'applied.json');
      const record = { rolloutId: 'repair-' + 'a'.repeat(32), identity: { handle: 'alice', machineId: 'machine-1', ownerId: 'user_1', runtimeSlot: 'primary', epoch: 2 }, afterSha256: createHash('sha256').update(original).digest('hex') };
      let value: unknown = record;
      if (state === 'incomplete') value = { rolloutId: record.rolloutId, identity: record.identity, beforeSha256: record.afterSha256 };
      if (state === 'invalid_hash') value = { ...record, afterSha256: 'invalid' };
      if (state === 'future_epoch') value = { ...record, identity: { ...record.identity, epoch: 3 } };
      if (state === 'wrong_identity') value = { ...record, identity: { ...record.identity, machineId: 'other' } };
      if (state === 'symlink') await symlink(f.envPath, applied);
      else await writeFile(applied, state === 'malformed' ? '{' : JSON.stringify(value), { mode: 0o600 });
      expect(apply(f.envPath, request, '', [applied]).status).not.toBe(0);
      expect(await readFile(f.envPath, 'utf8')).toBe(original);
    });
  it('rejects a currently active protected component even before its pending marker is written', async () => {
    const f = await fixture(); const applied = join(f.dir, 'applied.json');
    const extra = "import fcntl\nheld=os.open(os.path.join(os.path.dirname(sys.argv[2]),'resume.lock'),os.O_RDWR|os.O_CREAT,0o600)\nfcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)";
    expect(apply(f.envPath, request, extra, [applied]).status).not.toBe(0);
    expect(await readFile(f.envPath, 'utf8')).toBe(original);
  });
});

describe('retained updater journal ownership under root activation', () => {
  it.each(['matrix', 'root', 'wrong_directory', 'wrong_file', 'wrong_release'])(
    'validates the trusted runtime account while preserving the root release anchor: %s', async ownerCase => {
      const f = await retainedUpdateFixture();
      const code = `import os,runpy,sys,types
m=runpy.run_path(sys.argv[1],run_name='ownership_test')
real_open,real_fstat=os.open,os.fstat
paths={}
def tracked_open(path,*args,**kwargs):
 fd=real_open(path,*args,**kwargs)
 paths[fd]=os.path.join(paths[kwargs['dir_fd']],path) if kwargs.get('dir_fd') is not None else os.fspath(path)
 return fd
def trusted_metadata(fd):
 value=list(real_fstat(fd));path=paths.get(fd,'');case=sys.argv[3]
 if path.endswith('release.json'):value[4]=4242 if case=='wrong_release' else 0
 elif path.endswith('update-transaction'):value[4]=4343 if case=='wrong_directory' else 0 if case=='root' else 4242
 elif path.endswith('/state') or path.endswith('/candidate-version'):value[4]=4343 if case=='wrong_file' else 0 if case=='root' else 4242
 return os.stat_result(value)
os.open=tracked_open;os.fstat=trusted_metadata;os.geteuid=lambda:0
m['completed_update_transaction'].__globals__['pwd']=types.SimpleNamespace(getpwnam=lambda name:types.SimpleNamespace(pw_uid=4242))
m['completed_update_transaction'](sys.argv[2])`;
      const result = spawnSync('python3', ['-c', code, helper, f.transaction, ownerCase], { encoding: 'utf8' });
      if (ownerCase === 'matrix' || ownerCase === 'root') expect(result.status, result.stderr).toBe(0);
      else expect(result.status).not.toBe(0);
      expect(await readFile(f.envPath, 'utf8')).toBe(original);
    });
});
