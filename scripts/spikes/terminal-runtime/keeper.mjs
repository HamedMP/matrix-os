#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { spawn } = require('node-pty');
const runtimeId = process.argv[2] ?? '';
const runtimeRoot = '/run/matrix-terminal-runtime-spike';
const zellij = '/opt/matrix/bin/zellij';
let stopping = false;
let monitor;
let pty;
let startupStage = 'descriptor';

const STARTUP_FAILURE_CODES = new Set([
  'runtime_id',
  'descriptor_schema',
  'descriptor_runtime',
  'descriptor_cwd',
  'descriptor_intent',
  'descriptor_size',
  'client_exit',
  'cgroup_unified',
  'cgroup_unit',
  'readiness_timeout',
]);

function exit(code) {
  if (monitor) clearInterval(monitor);
  if (pty) {
    try {
      pty.kill();
    } catch (error) {
      if (!(error instanceof Error)) process.exitCode = 1;
    }
  }
  process.exit(code);
}

function parseDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('descriptor_schema');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'cwd,intent,runtimeId') throw new Error('descriptor_schema');
  if (value.runtimeId !== runtimeId) throw new Error('descriptor_runtime');
  if (value.cwd !== '/home/matrix/home') throw new Error('descriptor_cwd');
  if (value.intent !== 'create' && value.intent !== 'recover') throw new Error('descriptor_intent');
  return value;
}

function zellijEnvironment() {
  return {
    HOME: '/home/matrix/home',
    MATRIX_HOME: '/home/matrix/home',
    PATH: '/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    XDG_CACHE_HOME: '/home/matrix/home/system/terminal-runtime-spike/cache',
    XDG_CONFIG_HOME: '/home/matrix/home/system/terminal-runtime-spike/config-home',
    XDG_DATA_HOME: '/home/matrix/home/system/terminal-runtime-spike/data',
    XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
    ZELLIJ_CONFIG_DIR: '/home/matrix/home/system/terminal-runtime-spike/config',
    ZELLIJ_CONFIG_FILE: '/home/matrix/home/system/terminal-runtime-spike/config/config.kdl',
  };
}

async function exactSessionResponds(sessionName, env) {
  try {
    const { stdout } = await execFileAsync(zellij, ['list-sessions', '--no-formatting'], {
      env,
      timeout: 2000,
      maxBuffer: 64 * 1024,
    });
    return stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[0] === sessionName);
  } catch (error) {
    return false;
  }
}

async function ownCgroup() {
  const membership = await readFile('/proc/self/cgroup', 'utf8');
  const unified = membership.split(/\r?\n/).find((line) => line.startsWith('0::'));
  if (!unified) throw new Error('cgroup_unified');
  const relative = unified.slice(3);
  if (!relative.includes('matrix-terminal-spike')) throw new Error('cgroup_unit');
  return { relative, path: `/sys/fs/cgroup${relative}` };
}

async function processInfo(pid) {
  try {
    const [comm, cmdline] = await Promise.all([
      readFile(`/proc/${pid}/comm`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`),
    ]);
    return {
      pid,
      comm: comm.trim(),
      cmdline: cmdline.toString('utf8').split('\u0000').filter(Boolean),
    };
  } catch (error) {
    return null;
  }
}

async function cgroupRoles(cgroupPath) {
  const raw = await readFile(`${cgroupPath}/cgroup.procs`, 'utf8');
  const pids = raw.split(/\s+/).filter(Boolean).map((value) => Number.parseInt(value, 10));
  const processes = (await Promise.all(pids.map(processInfo))).filter(Boolean);
  const zellijPids = processes.filter((process) => process.comm === 'zellij').map((process) => process.pid);
  const shell = processes.find((entry) => entry.comm === 'bash');
  const agent = processes.find((process) => process.cmdline[0] === 'matrix-agent-probe');
  if (zellijPids.length < 2 || !shell || !agent) return null;
  return {
    keeper: process.pid,
    zellij: zellijPids.sort((a, b) => a - b),
    shell: shell.pid,
    agent: agent.pid,
  };
}

async function writeReadiness(value) {
  await writeFile(`${runtimeRoot}/readiness/${runtimeId}.json`, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

async function notifyReady() {
  await execFileAsync('/usr/bin/systemd-notify', ['--ready', `--pid=${process.pid}`, '--status=terminal-runtime-spike-ready'], {
    env: process.env,
    timeout: 2000,
    maxBuffer: 16 * 1024,
  });
}

async function recordStartupFailure(error) {
  const code = error instanceof Error && STARTUP_FAILURE_CODES.has(error.message)
    ? error.message
    : 'startup_failed';
  try {
    await writeFile(`${runtimeRoot}/startup-failures/${runtimeId}.json`, `${JSON.stringify({
      stage: startupStage,
      code,
    })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (writeError) {
    const writeCode = writeError && typeof writeError === 'object' && 'code' in writeError
      ? writeError.code
      : '';
    if (writeCode !== 'EEXIST') process.exitCode = 1;
  }
}

async function main() {
  if (!/^[0-9a-f]{32}$/.test(runtimeId)) throw new Error('runtime_id');
  const descriptorPath = `${runtimeRoot}/descriptors/${runtimeId}.json`;
  const descriptorRaw = await readFile(descriptorPath, { encoding: 'utf8', flag: 'r' });
  if (Buffer.byteLength(descriptorRaw) > 4096) throw new Error('descriptor_size');
  const descriptor = parseDescriptor(JSON.parse(descriptorRaw));
  await unlink(descriptorPath);

  startupStage = 'launch';
  const env = zellijEnvironment();
  const sessionName = `matrix-t-${runtimeId}`;
  const args = descriptor.intent === 'recover'
    ? ['attach', sessionName]
    : ['--session', sessionName, '--new-session-with-layout', '/opt/matrix/libexec/terminal-runtime-spike/layout.kdl'];
  pty = spawn(zellij, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: '/home/matrix/home',
    env,
  });
  let clientExited = false;
  let confirmationRecorded = false;
  let confirmationBuffer = '';
  pty.onData((data) => {
    confirmationBuffer = `${confirmationBuffer}${data}`.slice(-4096);
    if (
      descriptor.intent === 'recover' &&
      !confirmationRecorded &&
      /press\s+enter\s+to\s+run/i.test(confirmationBuffer)
    ) {
      confirmationRecorded = true;
      void writeFile(`${runtimeRoot}/confirmations/${runtimeId}.pass`, 'pass\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }).catch((error) => {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
        if (code !== 'EEXIST') exit(19);
      });
    }
  });
  pty.onExit(() => {
    clientExited = true;
    if (!stopping) exit(17);
  });

  startupStage = 'cgroup';
  const cgroup = await ownCgroup();
  startupStage = 'readiness';
  const deadline = Date.now() + 25_000;
  let roles = null;
  while (Date.now() < deadline) {
    if (clientExited) throw new Error('client_exit');
    const [responsive, detected] = await Promise.all([
      exactSessionResponds(sessionName, env),
      cgroupRoles(cgroup.path),
    ]);
    if (responsive && detected) {
      roles = detected;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!roles) throw new Error('readiness_timeout');
  await writeReadiness({ runtimeId, sessionName, cgroup: cgroup.relative, roles });
  startupStage = 'notify';
  await notifyReady();

  let checking = false;
  monitor = setInterval(async () => {
    if (stopping || checking) return;
    checking = true;
    try {
      if (clientExited || !await exactSessionResponds(sessionName, env)) exit(18);
    } finally {
      checking = false;
    }
  }, 1000);
}

process.on('SIGTERM', () => {
  stopping = true;
  exit(0);
});
process.on('SIGINT', () => {
  stopping = true;
  exit(0);
});

try {
  await main();
} catch (error) {
  await recordStartupFailure(error);
  exit(16);
}
