import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

assert.equal(process.platform, 'linux');
const artifacts = Object.freeze({
  arm64: '92f2b4fd05d0bdcf7b9a0d4e0ecef4a1e4b368b290cd8fd07cff9a50013f45a2',
  x64: '1e08503dbdf3c2cb0d706d32f3408277388d1c76ef108673e8fe42c1b322925b',
});
assert.ok(Object.hasOwn(artifacts, process.arch), 'qualified Linux native architecture required');
assert.equal(process.getuid(), 65534);
const status = await readFile('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
assert.deepEqual(await readdir('/sys/class/net'), ['lo']);
const routes = await readFile('/proc/net/route', 'utf8');
assert.equal(routes.trim().split('\n').length, 1);
await assert.rejects(readFile('/var/run/docker.sock'), { code: 'ENOENT' });
await assert.rejects(writeFile('/var/tmp/owned-rootfs-canary', 'synthetic'), error => ['EROFS', 'EACCES'].includes(error.code));
const hasher = createHash('sha256');
for await (const chunk of createReadStream('/fixture/claude', { highWaterMark: 65536 })) hasher.update(chunk);
const digest = hasher.digest('hex');
assert.equal(digest, artifacts[process.arch]);
await mkdir('/tmp/owned/home', { recursive: true });
await mkdir('/tmp/owned/config', { recursive: true });
const env = { HOME: '/tmp/owned/home', CLAUDE_CONFIG_DIR: '/tmp/owned/config', TMPDIR: '/tmp/owned',
  PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', USER: 'nobody', SHELL: '/bin/sh',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' };
const child = spawn('/fixture/claude', ['--version'], { cwd: '/tmp/owned', env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
for (const [stream, append] of [[child.stdout, value => stdout += value], [child.stderr, value => stderr += value]]) {
  stream.on('data', chunk => {
    append(chunk.toString());
    if (stdout.length + stderr.length > 16384) child.kill('SIGKILL');
  });
}
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
}).finally(() => clearTimeout(timer));
assert.equal(result.code, 0, stderr.slice(0, 1000));
assert.equal(stdout.trim(), '2.1.280 (Claude Code)');
console.log(JSON.stringify({ isolation: { nonroot: true, capabilitiesZero: true, noNewPrivileges: true,
  onlyLoopbackInterface: true, noRoutes: true, noDockerSocket: true, rootfsWriteDenied: true },
  native: { package: `@anthropic-ai/claude-code-linux-${process.arch}`, packageVersion: '2.1.280', reportedVersion: stdout.trim(), sha256: digest, exit: result.code },
  externalRequestsAttempted: 0, realAccountUsed: false, hookQualified: false }));
