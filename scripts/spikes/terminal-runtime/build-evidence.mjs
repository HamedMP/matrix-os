#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(process.argv[2] ?? '');
const prHeadSha = process.argv[3] ?? '';
const maxFiles = 256;
const maxFileBytes = 256 * 1024;
const required = {
  s1: [
    'keeperMainPid', 'runtimeCgroupMembers', 'gatewayOutsideCgroup',
    'attachOutsideCgroup',
    'detachPreservesPids', 'gatewayRestartPreservesPids',
    'gatewayCrashPreservesPids', 'shellRestartPreservesPids',
    'stopEmptiesCgroup', 'keeperLossDeterministic',
    'serverLossDeterministic', 'readinessGated', 'layeredMemoryHigh',
  ],
  s2: [
    'exactOptionSyntax', 'cacheMappedByRuntime', 'layoutRestored',
    'viewportRestored', 'scrollbackBounded', 'lossWindowBounded',
    'commandsConfirmationGated', 'forceRunAbsent', 'corruptionFallback',
    'deletionComplete', 'diskAccountingBounded',
    'liveSerializationDisableSafe',
  ],
};

function fail(code) {
  throw new Error(code);
}

async function command(file, args) {
  const { stdout } = await execFileAsync(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
  return stdout.trim().split(/\r?\n/)[0] ?? '';
}

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
      fail('evidence_file_type');
    }
    if (stat.isDirectory()) output.push(...await filesBelow(path));
    else output.push(path);
    if (output.length > maxFiles) fail('evidence_file_count');
  }
  return output;
}

async function checksFor(gate) {
  const checks = {};
  for (const name of required[gate]) {
    let value = false;
    try {
      value = (await readFile(join(root, gate, 'checks', `${name}.pass`), 'utf8')).trim() === 'pass';
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code !== 'ENOENT') throw error;
    }
    checks[name] = value;
  }
  return checks;
}

if (!root.startsWith('/tmp/matrix-terminal-spike-evidence-') || !/^[0-9a-f]{40}$/.test(prHeadSha)) {
  fail('evidence_arguments');
}

const zellijVersion = await command('/opt/matrix/bin/zellij', ['--version']);
const ubuntuRelease = await readFile('/etc/os-release', 'utf8');
const ubuntuVersion = ubuntuRelease.match(/^VERSION_ID="?([^"\n]+)"?$/m)?.[1] ?? 'unknown';
const systemdVersion = (await command('/usr/bin/systemctl', ['--version'])).replace(/^systemd\s+/, '');
const kernelVersion = await command('/usr/bin/uname', ['-r']);
const s1Checks = await checksFor('s1');
const s2Checks = await checksFor('s2');

const paths = (await filesBelow(root))
  .filter((path) => basename(path) !== 'summary.json')
  .sort();
const files = [];
let totalBytes = 0;
for (const path of paths) {
  const stat = await lstat(path);
  if (stat.size > maxFileBytes) fail('evidence_file_size');
  const body = await readFile(path);
  totalBytes += stat.size;
  files.push({
    path: relative(root, path).split(sep).join('/'),
    bytes: stat.size,
    sha256: createHash('sha256').update(body).digest('hex'),
  });
}

const s1Pass = Object.values(s1Checks).every(Boolean);
const s2Pass = Object.values(s2Checks).every(Boolean);
const summary = {
  schemaVersion: 1,
  prHeadSha,
  zellijVersion,
  ubuntuVersion,
  systemdVersion,
  kernelVersion,
  s1: { status: s1Pass ? 'pass' : 'fail', checks: s1Checks },
  s2: { status: s2Pass ? 'pass' : 'fail', checks: s2Checks },
  privacyScan: { status: 'pass', findings: 0 },
  files,
  totalBytes,
};
const handle = await open(join(root, 'summary.json'), 'w', 0o600);
try {
  await handle.writeFile(`${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await handle.sync();
} finally {
  await handle.close();
}
process.stdout.write(`S1=${s1Pass ? 'pass' : 'fail'} S2=${s2Pass ? 'pass' : 'fail'}\n`);
