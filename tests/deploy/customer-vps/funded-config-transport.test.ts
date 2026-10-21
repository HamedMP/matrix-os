import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFundedConfigRepairCommand, sealFundedConfigRepair } from '../../../scripts/ops/funded-config-repair-transport.mjs';

const authToken = 'b'.repeat(64);
const runtimeToken = 'a'.repeat(64);
const roots: string[] = [];
const identity = { machineId: 'example-machine', ownerId: 'user_example', handle: 'example-main', runtimeSlot: 'primary', epoch: 2 };
const request = { action: 'apply', rolloutId: 'example', identity, expectedFile: { sha256: 'c'.repeat(64), inode: 1, device: 1 }, quiescentWindow: true, config: { relayUrl: 'https://relay.example.com', runtimeToken } };
const source = `import json,sys
r=json.load(sys.stdin)
assert len(sys.argv)==1 and r['config']['runtimeToken']=='a'*64
print(json.dumps({'action':r['action'],'changed':False,'restartRequired':False,'beforeSha256':'c'*64,'afterSha256':'c'*64,'backup':None}))
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'matrix-funding-envelope-'));
  roots.push(root); chmodSync(root, 0o750);
  const path = join(root, 'host.env');
  const contents = `MATRIX_MACHINE_ID=example-machine\nMATRIX_CLERK_USER_ID=user_example\nMATRIX_HANDLE=example-main\nMATRIX_RUNTIME_SLOT=primary\nMATRIX_RUNTIME_TOKEN_EPOCH=2\nMATRIX_AUTH_TOKEN=${authToken}\n`;
  writeFileSync(path, contents, { mode: 0o640 });
  return { root, path, contents };
}

function bridge(transport: unknown, path: string, anchored = false, setup = '') {
  const modulePath = resolve('scripts/ops/funded-config-repair-transport.mjs');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { executeFundedConfigRepairBridge } from ${JSON.stringify(modulePath)};
import * as fs from 'node:fs';
const base=process.argv[1].slice(0,-'/opt/matrix/env/host.env'.length);
const paths={opt:base+'/opt',matrix:base+'/opt/matrix',env:base+'/opt/matrix/env'};
const descriptors=${anchored ? "Object.fromEntries(Object.entries({...paths,host:process.argv[1]}).map(([key,path])=>[key,fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)]))" : 'undefined'};
${setup}
try { console.log(JSON.stringify(executeFundedConfigRepairBridge(JSON.parse(fs.readFileSync(0,'utf8')), { envPath:process.argv[1], uid:process.getuid(), gid:process.getgid(), pythonPath:'/usr/bin/python3', checkAncestors:${anchored}, descriptors,ancestorPaths:paths }))); }
catch { console.error(JSON.stringify({error:'transport_failed'}));process.exit(1); }
`, path], { input: JSON.stringify(transport), encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) expect(JSON.parse(result.stderr)).toEqual({ error: 'transport_failed' });
  return result;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('authenticated stdin funding repair transport', () => {
  function supportedFixture() {
    const result = fixture();
    mkdirSync(join(result.root, 'opt'), { mode: 0o755 });
    mkdirSync(join(result.root, 'opt/matrix'), { mode: 0o770 }); chmodSync(join(result.root, 'opt/matrix'), 0o770);
    mkdirSync(join(result.root, 'opt/matrix/env'), { mode: 0o750 });
    const path = join(result.root, 'opt/matrix/env/host.env'); writeFileSync(path, result.contents, { mode: 0o640 });
    return { ...result, path };
  }

  it('accepts provisioned ancestors through inherited descriptors and passes only the env descriptor to Python', () => {
    const { path } = supportedFixture();
    const inherited = "import os\nassert os.fstat(3).st_mode & 0o170000 == 0o040000\nassert os.environ['MATRIX_FUNDED_REPAIR_ENV_FD']=='3'\n" + source;
    const result = bridge(sealFundedConfigRepair(request, inherited, authToken), path, true);
    expect(result.status, result.stderr).toBe(0);
  });

  it('carries a URL-only request without exporting the installed funded token through the existing bridge', () => {
    const { path } = supportedFixture();
    const input = { ...request, action: 'align-routing',
      expectedRelease: { version: 'v2026.10.11-test', gitCommit: 'e'.repeat(40) },
      config: { relayUrl: 'https://relay.example.com', platformUrl: 'https://platform.example.com' } };
    const routeSource = source.replace("r['config']['runtimeToken']=='a'*64",
      "set(r['config'])=={'relayUrl','platformUrl'} and r['expectedRelease']['gitCommit']=='e'*40");
    const result = bridge(sealFundedConfigRepair(input, routeSource, authToken), path, true);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: 'align-routing', changed: false });
    expect(result.stdout + result.stderr).not.toContain(authToken);
    const actual = readFileSync(resolve('scripts/ops/repair-funded-chat-config.py'), 'utf8');
    expect(() => buildFundedConfigRepairCommand(input, actual, authToken, 'e'.repeat(64))).not.toThrow();
  });

  it('redacts an installed token accidentally returned in a URL-only helper receipt', () => {
    const { path, contents } = supportedFixture();
    writeFileSync(path, contents + `MATRIX_FUNDED_AI_RUNTIME_TOKEN=${runtimeToken}\n`);
    const input = { ...request, action: 'align-routing',
      expectedRelease: { version: 'v2026.10.11-test', gitCommit: 'e'.repeat(40) },
      config: { relayUrl: 'https://relay.example.com', platformUrl: 'https://platform.example.com' } };
    const bad = `import json,sys\nr=json.load(sys.stdin)\nt=[l.split('=',1)[1] for l in open(${JSON.stringify(path)}).read().splitlines() if l.startswith('MATRIX_FUNDED_AI_RUNTIME_TOKEN=')][0]\nprint(json.dumps({'action':r['action'],'changed':False,'restartRequired':False,'beforeSha256':t,'afterSha256':'c'*64,'backup':None}))`;
    const result = bridge(sealFundedConfigRepair(input, bad, authToken), path, true);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(runtimeToken);
  });

  it('fits routing commands with realistic noncompressible CAS and two service origins', () => {
    const actual = readFileSync(resolve('scripts/ops/repair-funded-chat-config.py'), 'utf8');
    const input = { ...request, action: 'align-routing',
      identity: { ...identity, machineId: '01234567-89ab-4cde-8fab-0123456789ab', ownerId: 'user_0123456789abcdefghijklmnopq' },
      expectedFile: { sha256: 'de876b2c41ba7852b83c15d03cafd35d211917a5c32f37b02183c898c0fae768', inode: 123456789, device: 16777232 },
      expectedRelease: { version: 'v2026.10.11-pr2503-38113907071-1-007c4e5', gitCommit: '007c4e560986ed0432ee7c385d21ca071f63ebed' },
      config: { relayUrl: 'https://matrix-ai-relay-production-abcdefghij-ey.a.run.app', platformUrl: 'https://matrix-platform-abcdefghij-ey.a.run.app' } };
    for (let attempt = 0; attempt < 8; attempt++) {
      const command = buildFundedConfigRepairCommand(input, actual, authToken, 'e'.repeat(64));
      expect(command.every((arg: string) => arg.length <= 4096)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify({ command, timeoutMs: 15_000 }))).toBeLessThanOrEqual(16_384);
    }
  });

  it('rejects canonical env rebinding and writable target directories with no secret output', () => {
    const a = supportedFixture(); chmodSync(join(a.root, 'opt/matrix/env'), 0o770);
    expect(bridge(sealFundedConfigRepair(request, source, authToken), a.path, true).status).toBe(1);
    const b = supportedFixture();
    const result = bridge(sealFundedConfigRepair(request, source, authToken), b.path, true,
      "fs.renameSync(paths.env,paths.env+'-old');fs.symlinkSync(base,paths.env);");
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(authToken);
  });

  it('refuses success after a child causes ancestor rebinding', () => {
    const { root, path } = supportedFixture();
    const moved = `import os\np=${JSON.stringify(join(root, 'opt/matrix/env'))}\nos.rename(p,p+'-old');os.symlink(${JSON.stringify(root)},p)\n` + source;
    const result = bridge(sealFundedConfigRepair(request, moved, authToken), path, true);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(runtimeToken);
    expect(readFileSync(join(root, 'host.env'), 'utf8')).toContain('MATRIX_AUTH_TOKEN=' + authToken);
  });

  it('decrypts the bound request and passes secrets only on child stdin', () => {
    const { path } = fixture();
    const transport = sealFundedConfigRepair(request, source, authToken);
    expect(JSON.stringify(transport)).not.toContain(runtimeToken);
    expect(JSON.stringify(transport)).not.toContain(authToken);
    const result = bridge(transport, path);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: 'apply', changed: false });
    expect(result.stdout + result.stderr).not.toContain(runtimeToken);
  });

  it('preserves legacy apply transport when the installed funded token is empty', () => {
    const { path, contents } = fixture();
    writeFileSync(path, contents + 'MATRIX_FUNDED_AI_RUNTIME_TOKEN=\n');
    const result = bridge(sealFundedConfigRepair(request, source, authToken), path);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: 'apply', changed: false });
  });

  it.each(['a', 'apply', 'true', 'old.token', 'abc+def', 'legacy._/:@%+~-TOKEN'])('returns the actual successful apply receipt after replacing malformed token %s', installed => {
    const { root, path, contents } = supportedFixture();
    writeFileSync(path, contents + `PLATFORM_INTERNAL_URL=https://platform.example.com\nMATRIX_FUNDED_AI_RUNTIME_TOKEN=${installed}\n`);
    const stat = lstatSync(path);
    const beforeSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    const input = { ...request, expectedFile: { sha256: beforeSha256, inode: stat.ino, device: stat.dev } };
    // Invoke the real atomic Python helper against this owned temporary env.
    const actual = `import importlib.util,json,os,sys\ns=importlib.util.spec_from_file_location('repair',${JSON.stringify(resolve('scripts/ops/repair-funded-chat-config.py'))})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nr=json.load(sys.stdin)\nprint(json.dumps(m.execute(r,${JSON.stringify(join(root, 'opt/matrix/env'))},os.getuid(),os.getgid(),lambda:None)))\n`;
    const result = bridge(sealFundedConfigRepair(input, actual, authToken), path, true);
    expect(readFileSync(path, 'utf8')).toContain(`MATRIX_FUNDED_AI_RUNTIME_TOKEN=${runtimeToken}\n`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: 'apply', changed: true, restartRequired: true, beforeSha256,
      afterSha256: createHash('sha256').update(readFileSync(path)).digest('hex'), backup: 'host.env.funded-example.json' });
    expect(result.stdout + result.stderr).not.toContain(runtimeToken);
    expect(result.stdout + result.stderr).not.toContain(authToken);
  });

  it.each(['bad token', 'bad;token', 'bad$token', '"quoted"'])('rejects non-literal installed token %s without changing the file', installed => {
    const { path, contents } = supportedFixture();
    const original = contents + `MATRIX_FUNDED_AI_RUNTIME_TOKEN=${installed}\n`;
    writeFileSync(path, original);
    expect(bridge(sealFundedConfigRepair(request, source, authToken), path, true).status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.each(['ciphertext', 'tag', 'salt', 'iv'])('rejects tampered %s before executing', field => {
    const { path } = fixture();
    const transport = sealFundedConfigRepair(request, source, authToken);
    const value = Buffer.from(transport.envelope[field], 'base64'); value[0] ^= 1;
    transport.envelope[field] = value.toString('base64');
    expect(bridge(transport, path).status).toBe(1);
  });

  it('rejects mutated AAD, expired requests, wrong auth keys, host identity and compressed helper', () => {
    const { path, contents } = fixture();
    const aad = sealFundedConfigRepair(request, source, authToken); aad.envelope.aad.action = 'rollback';
    expect(bridge(aad, path).status).toBe(1);
    expect(bridge(sealFundedConfigRepair(request, source, authToken, Date.now() - 180_000), path).status).toBe(1);
    expect(bridge(sealFundedConfigRepair(request, source, 'd'.repeat(64)), path).status).toBe(1);
    const badSource = sealFundedConfigRepair(request, source, authToken); badSource.helper = Buffer.from('wrong source').toString('base64');
    expect(bridge(badSource, path).status).toBe(1);
    writeFileSync(path, contents.replace('example-machine', 'different-machine'));
    expect(bridge(sealFundedConfigRepair(request, source, authToken), path).status).toBe(1);
  });

  it('rejects permissive host env modes and duplicate auth keys', () => {
    const { path, contents } = fixture();
    chmodSync(path, 0o644);
    expect(bridge(sealFundedConfigRepair(request, source, authToken), path).status).toBe(1);
    chmodSync(path, 0o640); writeFileSync(path, contents + `MATRIX_AUTH_TOKEN=${authToken}\n`);
    expect(bridge(sealFundedConfigRepair(request, source, authToken), path).status).toBe(1);
  });

  it('fits the actual reviewed Python helper and opaque envelope in terminal argument/body limits', () => {
    const actual = readFileSync(resolve('scripts/ops/repair-funded-chat-config.py'), 'utf8');
    const command = buildFundedConfigRepairCommand(request, actual, authToken, 'e'.repeat(64));
    expect(command.slice(0, 3)).toEqual(['/usr/bin/sudo', '-n', '/usr/bin/python3']);
    expect(command.length).toBeLessThanOrEqual(64);
    expect(command.every((arg: string) => arg.length <= 4096)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ command, timeoutMs: 15_000 }))).toBeLessThanOrEqual(16_384);
    expect(JSON.stringify(command)).not.toContain(authToken);
    expect(JSON.stringify(command)).not.toContain(runtimeToken);
    expect(JSON.stringify(command)).not.toContain('platform-secret');
    // Exercise the actual compressed bootstrap/argv reconstruction. Its fixed
    // production identity/path rejects this unprivileged synthetic request.
    const result = spawnSync('/usr/bin/python3', command.slice(3), { encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ error: 'transport_failed' });
  });

  it('redacts output if a helper accidentally emits secrets or malformed receipts', () => {
    const { path } = fixture();
    const bad = `import json,sys\nr=json.load(sys.stdin)\nprint(r['config']['runtimeToken'])`;
    const result = bridge(sealFundedConfigRepair(request, bad, authToken), path);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(runtimeToken);
    const receiptSecret = source.replace("'beforeSha256':'c'*64", "'beforeSha256':r['config']['runtimeToken']");
    const secretResult = bridge(sealFundedConfigRepair(request, receiptSecret, authToken), path);
    expect(secretResult.status).toBe(1);
    expect(secretResult.stdout + secretResult.stderr).not.toContain(runtimeToken);
  });

  it('rejects oversized or invalid operator input before creating a command', () => {
    expect(() => buildFundedConfigRepairCommand(request, source, authToken)).toThrow('Node digest');
    expect(() => sealFundedConfigRepair({ ...request, padding: 'x'.repeat(4096) }, source, authToken)).toThrow();
    expect(() => sealFundedConfigRepair(request, source.repeat(1000), authToken)).toThrow();
    expect(() => sealFundedConfigRepair(request, source, 'invalid')).toThrow();
    expect(() => sealFundedConfigRepair(request, source + `# ${runtimeToken}`, authToken)).toThrow();
    expect(() => sealFundedConfigRepair(request, source + `# ${authToken}`, authToken)).toThrow();
  });

  it('bounds launcher inflation and rejects incomplete or trailing compressed source with redacted errors', () => {
    const command = buildFundedConfigRepairCommand(request, source, authToken, 'e'.repeat(64));
    const compressed = Buffer.from(command[6], 'base64');
    for (const invalid of [deflateSync(Buffer.from('print("untrusted executed")\n'.repeat(10_000))), compressed.subarray(0, compressed.length - 2), Buffer.concat([compressed, Buffer.from('trailing')])]) {
      const altered = [...command]; altered[6] = invalid.toString('base64');
      const result = spawnSync('/usr/bin/python3', altered.slice(3), { encoding: 'utf8', timeout: 5000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({ error: 'transport_failed' });
    }
  });
});
