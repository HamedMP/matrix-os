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
function apply(envPath: string, body: unknown = request, extra = '') {
  const now = new Date();
  const proof = { ...body as object, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30000).toISOString() };
  return spawnSync('python3', ['-c', `import json,runpy,sys,os\nm=runpy.run_path(sys.argv[1],run_name='test_helper')\n${extra}\nm['apply_config'](sys.argv[2],json.loads(sys.stdin.read()),markers=())`, helper, envPath], { encoding: 'utf8', input: JSON.stringify(proof) });
}
describe('funded AI host configuration primitive', () => {
  it('activates trailing-hyphen handles accepted by platform provisioning', async () => {
    const f = await fixture();
    await writeFile(f.envPath, original.replace('MATRIX_HANDLE=alice', 'MATRIX_HANDLE=alice-'));
    const result = apply(f.envPath, { ...request, identity: { ...request.identity, handle: 'alice-' } });
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
