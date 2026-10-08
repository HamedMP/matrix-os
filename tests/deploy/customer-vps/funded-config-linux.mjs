// Manual Linux integration fixture, exclusively inside a disposable container.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { buildFundedConfigRepairCommand } from '../../../scripts/ops/funded-config-repair-transport.mjs';

assert(process.platform === 'linux' && process.getuid() === 0 && existsSync('/.dockerenv')
  && process.env.MATRIX_FUNDED_REPAIR_DISPOSABLE_TEST === '1' && !existsSync('/opt/matrix'),
'This fixture requires a fresh disposable Linux container; never run on a VPS.');
const group = spawnSync('/usr/sbin/groupadd', ['-g', '2001', 'matrix']);
assert.equal(group.status, 0);
for (const [path, mode] of [['/opt/matrix', 0o770], ['/opt/matrix/env', 0o750], ['/opt/matrix/runtime', 0o755],
  ['/opt/matrix/runtime/node', 0o755], ['/opt/matrix/runtime/node/bin', 0o2775]]) {
  mkdirSync(path); chownSync(path, 0, 2001); chmodSync(path, mode);
}
const runtime = '/opt/matrix/runtime/node/bin/node';
const vendorBytes = readFileSync(process.execPath); // Trusted immutable test-image bytes, before fixture copying.
const pin = createHash('sha256').update(vendorBytes).digest('hex');
copyFileSync(process.execPath, runtime); chownSync(runtime, 0, 2001); chmodSync(runtime, 0o775);
const path = '/opt/matrix/env/host.env';
const initial = 'MATRIX_MACHINE_ID=example-machine\nMATRIX_CLERK_USER_ID=user_example\nMATRIX_HANDLE=example-main\nMATRIX_RUNTIME_SLOT=primary\nMATRIX_RUNTIME_TOKEN_EPOCH=2\nPLATFORM_INTERNAL_URL=https://platform.example.com\nMATRIX_AUTH_TOKEN=' + 'b'.repeat(64) + '\n';
writeFileSync(path, initial, { mode: 0o640 }); chownSync(path, 0, 2001);
const helper = readFileSync(new URL('../../../scripts/ops/repair-funded-chat-config.py', import.meta.url), 'utf8');
function request(action = 'apply') {
  const info = statSync(path);
  return { action, rolloutId: 'linux-fixture', identity: { machineId: 'example-machine', ownerId: 'user_example', handle: 'example-main', runtimeSlot: 'primary', epoch: 2 },
    expectedFile: { sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), inode: info.ino, device: info.dev }, quiescentWindow: true,
    ...(action === 'apply' ? { config: { relayUrl: 'https://relay.example.com', runtimeToken: 'a'.repeat(64) } } : {}) };
}
function run(input, source = helper, hash = pin) {
  const command = buildFundedConfigRepairCommand(input, source, 'b'.repeat(64), hash);
  assert(Buffer.byteLength(JSON.stringify({ command, timeoutMs: 15000 })) <= 16384);
  const result = spawnSync(command[2], command.slice(3), { encoding: 'utf8', timeout: 15000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require=/untrusted', NODE_PATH: '/untrusted' } });
  assert(!result.stdout.includes('a'.repeat(64)) && !result.stderr.includes('b'.repeat(64)));
  return result;
}

let result = run(request()); assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).changed, true); assert(readFileSync(path, 'utf8').includes('MATRIX_FUNDED_AI_ENABLED=true'));
result = run(request()); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).changed, false);
result = run(request('rollback')); assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(path, 'utf8'), initial);

// A group-writable runtime replacement never becomes privileged executable code.
writeFileSync(runtime, '#!/bin/sh\ntouch /tmp/untrusted-executed\n');
result = run(request()); assert.equal(result.status, 1); assert(!existsSync('/tmp/untrusted-executed'));
copyFileSync(process.execPath, runtime); chownSync(runtime, 0, 2001); chmodSync(runtime, 0o775);
result = run(request('rollback')); assert.equal(result.status, 0, result.stderr);
result = run(request(), helper, '0'.repeat(64)); assert.equal(result.status, 1);

// A rebind during the helper is rejected; the victim is not opened for a write.
mkdirSync('/tmp/victim'); writeFileSync('/tmp/victim/host.env', 'victim untouched\n');
const attack = `original=known_activity\ncalls=0\ndef rebound():\n global calls\n calls+=1\n with open('/tmp/activity-calls','w') as f:f.write(str(calls))\n if calls==2:\n  os.rename('/opt/matrix/env','/opt/matrix/env-original');os.symlink('/tmp/victim','/opt/matrix/env')\n original()\nknown_activity=rebound\n`;
const attackedSource = helper.replace('if __name__ == "__main__":', attack + '\nif __name__ == "__main__":');
const attackRequest = request(); attackRequest.rolloutId = 'linux-rebind';
result = run(attackRequest, attackedSource); assert.equal(result.status, 1); assert.equal(readFileSync('/tmp/victim/host.env', 'utf8'), 'victim untouched\n');
assert(lstatSync('/opt/matrix/env').isSymbolicLink(), 'The attack must actually reach the rebind branch: ' + (existsSync('/tmp/activity-calls') ? readFileSync('/tmp/activity-calls','utf8') : 'no helper activity'));
rmSync('/opt/matrix/env');
// Container is removed by --rm; no customer configuration was touched.
console.log(JSON.stringify({ supportedLayout: '0770/0750/0640', apply: 'passed', noOp: 'passed', rollback: 'passed', sealedInterpreter: 'passed', writableRuntimeReplacement: 'rejected', wrongPin: 'rejected', ancestorRebind: 'rejected', inheritedEnvFd: 3, sanitizedEnvironment: 'passed' }));
