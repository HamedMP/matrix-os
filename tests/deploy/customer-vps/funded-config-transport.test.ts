import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function bridge(transport: unknown, path: string) {
  const modulePath = resolve('scripts/ops/funded-config-repair-transport.mjs');
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
import { executeFundedConfigRepairBridge } from ${JSON.stringify(modulePath)};
import { readFileSync } from 'node:fs';
try { console.log(JSON.stringify(executeFundedConfigRepairBridge(JSON.parse(readFileSync(0,'utf8')), { envPath:process.argv[1], uid:process.getuid(), gid:process.getgid(), pythonPath:'/usr/bin/python3', checkAncestors:false }))); }
catch { console.error(JSON.stringify({error:'transport_failed'}));process.exit(1); }
`, path], { input: JSON.stringify(transport), encoding: 'utf8', timeout: 15_000 });
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('authenticated stdin funding repair transport', () => {
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
    const command = buildFundedConfigRepairCommand(request, actual, authToken);
    expect(command.slice(0, 3)).toEqual(['/usr/bin/sudo', '-n', '/opt/matrix/runtime/node/bin/node']);
    expect(command.length).toBeLessThanOrEqual(64);
    expect(command.every((arg: string) => arg.length <= 4096)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ command, timeoutMs: 15_000 }))).toBeLessThanOrEqual(16_384);
    expect(JSON.stringify(command)).not.toContain(authToken);
    expect(JSON.stringify(command)).not.toContain(runtimeToken);
    expect(JSON.stringify(command)).not.toContain('platform-secret');
    // Exercise the actual compressed bootstrap/argv reconstruction. Its fixed
    // production identity/path rejects this unprivileged synthetic request.
    const result = spawnSync(process.execPath, command.slice(3), { encoding: 'utf8', timeout: 15_000 });
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
    expect(() => sealFundedConfigRepair({ ...request, padding: 'x'.repeat(4096) }, source, authToken)).toThrow();
    expect(() => sealFundedConfigRepair(request, source.repeat(1000), authToken)).toThrow();
    expect(() => sealFundedConfigRepair(request, source, 'invalid')).toThrow();
    expect(() => sealFundedConfigRepair(request, source + `# ${runtimeToken}`, authToken)).toThrow();
    expect(() => sealFundedConfigRepair(request, source + `# ${authToken}`, authToken)).toThrow();
  });
});
