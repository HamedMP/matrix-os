#!/usr/bin/env node
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
const execFileAsync = promisify(execFile);
const keeperExecutable = await realpath(fileURLToPath(import.meta.url));
const require = createRequire(keeperExecutable);
const sessionQueryWorkerMode = process.argv[2] === '--session-query-worker';
const runtimeId = process.argv[sessionQueryWorkerMode ? 3 : 2] ?? '';
const runNamespace = runtimeId.slice(1);
const runtimeRoot = `/run/matrix-terminal-runtime-spikes/${runNamespace}`;
const stateRoot = `/home/matrix/home/system/terminal-runtime-spikes/${runNamespace}`;
const zellij = '/opt/matrix/bin/zellij';
const WORKLOAD_PANE = '/opt/matrix/bin/matrix-terminal-spike-pane';
const WORKLOAD_PANE_NAME = 'matrix-runtime-workload-probe';
const WORKLOAD_PANE_STATES = new Set([
  'not_launched',
  'missing',
  'running',
  'held_success',
  'held_failure',
  'other',
  'ambiguous',
]);
let stopping = false;
let monitor;
let startupWatchdog;
let pty;
let spawnPty;
let startupStage = 'descriptor';
let clientExited = false;
let clientExitEvent = null;
let ready = false;
const confirmationSent = false;
let renderWindow = '';
let gateRecorded = false;
let paneReleasedRecorded = false;
let confirmationState = 'waiting';
const heldPaneCount = 0;
let workloadPaneLaunched = false;
let workloadPaneState = 'not_launched';
let workloadPaneExitStatus = null;
let startupFailureStarted = false;
let startupStageRevision = 0;
let roleSnapshot = { responsive: false, zellij: 0, shell: false, agent: false };
const STARTUP_FAILURE_CODES = new Set([
  'runtime_id',
  'descriptor_schema',
  'descriptor_runtime',
  'descriptor_cwd',
  'descriptor_intent',
  'descriptor_size',
  'native_binding',
  'client_exit',
  'cgroup_unified',
  'cgroup_unit',
  'workload_launch',
  'readiness_timeout',
]);
function exit(code) {
  if (monitor) clearInterval(monitor);
  if (startupWatchdog) clearTimeout(startupWatchdog);
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
    XDG_CACHE_HOME: `${stateRoot}/cache`,
    XDG_CONFIG_HOME: `${stateRoot}/config-home`,
    XDG_DATA_HOME: `${stateRoot}/data`,
    XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
    ZELLIJ_CONFIG_DIR: `${stateRoot}/config`,
    ZELLIJ_CONFIG_FILE: `${stateRoot}/config/config.kdl`,
  };
}
function terminateProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid < 1) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    if (code !== 'ESRCH') roleSnapshot.responsive = false;
  }
}
async function runSessionQueryWorker() {
  if (!/^[0-9a-f]{32}$/.test(runtimeId) || typeof process.send !== 'function') {
    process.exitCode = 2;
    return;
  }
  const sessionName = `matrix-t-${runtimeId}`;
  const child = spawnProcess(zellij, ['list-sessions', '--no-formatting'], {
    env: zellijEnvironment(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  child.stdout?.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      overflow = true;
      child.kill('SIGKILL');
      return;
    }
    chunks.push(chunk);
  });
  const responsive = await new Promise((resolve) => {
    child.once('error', () => resolve(false));
    child.once('close', (code, signal) => {
      if (code !== 0 || signal || overflow) {
        resolve(false);
        return;
      }
      const output = Buffer.concat(chunks).toString('utf8');
      resolve(output.split(/\r?\n/).some(
        (line) => line.trim().split(/\s+/)[0] === sessionName,
      ));
    });
  });
  await new Promise((resolve, reject) => {
    process.send({ responsive }, (error) => error ? reject(error) : resolve());
  });
  process.disconnect();
}
async function exactSessionResponds() {
  return await new Promise((resolve) => {
    let settled = false;
    const child = spawnProcess(process.execPath, [keeperExecutable, '--session-query-worker', runtimeId], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const finish = (result, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      if (terminate && child.pid) terminateProcessGroup(child.pid);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false, true), 2000);
    child.once('message', (message) => {
      const valid = message !== null && typeof message === 'object' && !Array.isArray(message)
        && Object.keys(message).join(',') === 'responsive'
        && typeof message.responsive === 'boolean';
      finish(valid && message.responsive, !valid);
    });
    child.once('error', () => finish(false, true));
    child.once('exit', () => finish(false));
  });
}
async function ownCgroup() {
  const membership = await readFile('/proc/self/cgroup', 'utf8');
  const unified = membership.split(/\r?\n/).find((line) => line.startsWith('0::'));
  if (!unified) throw new Error('cgroup_unified');
  const relative = unified.slice(3);
  if (!relative.includes('matrix-terminal-spike')) throw new Error('cgroup_unit');
  return { relative, path: `/sys/fs/cgroup${relative}` };
}
async function regularFileExists(path) {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    if (code === 'ENOENT') return false;
    throw error;
  }
}
async function launchCreateWorkloadPane(sessionName, env) {
  try {
    // The production candidate does not reliably emit its documented pane ID.
    // Successful completion is followed by authoritative cgroup role checks.
    await execFileAsync(
      zellij,
      ['--session', sessionName, 'action', 'new-pane', '--name', WORKLOAD_PANE_NAME, '--', WORKLOAD_PANE],
      { env, timeout: 2000, maxBuffer: 16 * 1024 },
    );
  } catch (error) {
    throw new Error('workload_launch', { cause: error });
  }
  workloadPaneLaunched = true;
  await recordStartupStage();
}
async function inspectWorkloadPane(sessionName, env) {
  workloadPaneExitStatus = null;
  try {
    const { stdout } = await execFileAsync(
      zellij,
      ['--session', sessionName, 'action', 'list-panes', '--all', '--json'],
      { env, timeout: 2000, maxBuffer: 64 * 1024 },
    );
    const panes = JSON.parse(stdout);
    if (!Array.isArray(panes) || panes.length > 16) return 'ambiguous';
    const matching = panes.filter((pane) => pane !== null
      && typeof pane === 'object'
      && !Array.isArray(pane)
      && pane.is_plugin === false
      && pane.title === WORKLOAD_PANE_NAME
      && pane.terminal_command === WORKLOAD_PANE);
    if (matching.length === 0) return 'missing';
    if (matching.length !== 1) return 'ambiguous';
    const [pane] = matching;
    if (typeof pane.is_held !== 'boolean' || typeof pane.exited !== 'boolean') return 'ambiguous';
    if (pane.exit_status !== null
      && (!Number.isInteger(pane.exit_status) || pane.exit_status < 0 || pane.exit_status > 255)) {
      return 'ambiguous';
    }
    workloadPaneExitStatus = pane.exit_status;
    if (pane.is_held || pane.exited) {
      if (pane.exit_status === 0) return 'held_success';
      if (Number.isInteger(pane.exit_status)) return 'held_failure';
      return 'other';
    }
    const commandLooksRunning = typeof pane.pane_command === 'string'
      && pane.pane_command.length <= 128
      && pane.pane_command?.startsWith('matrix-agent-probe ')
      && pane.pane_command === 'matrix-agent-probe 86400';
    return commandLooksRunning ? 'running' : 'other';
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return 'ambiguous';
  }
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
async function cgroupRoles(cgroupPath, requireWorkload) {
  const raw = await readFile(`${cgroupPath}/cgroup.procs`, 'utf8');
  const pids = raw.split(/\s+/).filter(Boolean).map((value) => Number.parseInt(value, 10));
  const processes = (await Promise.all(pids.map(processInfo))).filter(Boolean);
  const zellijPids = processes
    .filter((process) => process.comm === 'zellij' && !process.cmdline.includes('list-sessions'))
    .map((process) => process.pid);
  const shell = processes.find((entry) => entry.comm === 'bash');
  const agent = processes.find((process) => process.cmdline[0] === 'matrix-agent-probe');
  roleSnapshot = { ...roleSnapshot, zellij: zellijPids.length, shell: Boolean(shell), agent: Boolean(agent) };
  if (zellijPids.length < 2 || (requireWorkload && (!shell || !agent))) return null;
  return {
    keeper: process.pid,
    zellij: zellijPids.sort((a, b) => a - b),
    shell: shell?.pid ?? 0,
    agent: agent?.pid ?? 0,
  };
}
async function writeReadiness(value) {
  await writeFile(`${runtimeRoot}/readiness/${runtimeId}.json`, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}
function startupSnapshot() {
  const boundedWorkloadPaneState = WORKLOAD_PANE_STATES.has(workloadPaneState)
    ? workloadPaneState
    : 'ambiguous';
  const boundedWorkloadPaneExitStatus = workloadPaneExitStatus === null ||
    Number.isInteger(workloadPaneExitStatus) && workloadPaneExitStatus >= 0 && workloadPaneExitStatus <= 255
    ? workloadPaneExitStatus
    : null;
  return {
    stage: startupStage,
    gateRecorded,
    paneReleased: paneReleasedRecorded,
    confirmationState,
    heldPaneCount,
    confirmationSent,
    workloadPaneState: boundedWorkloadPaneState,
    workloadPaneExitStatus: boundedWorkloadPaneExitStatus,
    ...roleSnapshot,
  };
}
async function recordStartupStage() {
  const temporaryPath = `${runtimeRoot}/startup-stages/.${runtimeId}.${process.pid}.${startupStageRevision++}.tmp`;
  const targetPath = `${runtimeRoot}/startup-stages/${runtimeId}.json`;
  await writeFile(temporaryPath, `${JSON.stringify(startupSnapshot())}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporaryPath, targetPath);
}
async function setStartupStage(stage) {
  startupStage = stage;
  await recordStartupStage();
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
  const receipt = { code, ...startupSnapshot() };
  if (code === 'client_exit' && clientExitEvent) {
    receipt.exitCode = clientExitEvent.exitCode;
    receipt.signal = clientExitEvent.signal;
  }
  try {
    await writeFile(`${runtimeRoot}/startup-failures/${runtimeId}.json`, `${JSON.stringify(receipt)}\n`, {
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
async function failStartup(code) {
  if (startupFailureStarted) return;
  startupFailureStarted = true;
  await recordStartupFailure(new Error(code));
  exit(16);
}
async function main() {
  if (!/^[0-9a-f]{32}$/.test(runtimeId)) throw new Error('runtime_id');
  startupWatchdog = setTimeout(() => {
    void failStartup('readiness_timeout');
  }, 25_000);
  await recordStartupStage();
  let nativePty; try { nativePty = require('node-pty'); } catch (error) { throw new Error('native_binding', { cause: error }); }
  if (typeof nativePty.spawn !== 'function') throw new Error('native_binding');
  spawnPty = nativePty.spawn;
  const descriptorPath = `${runtimeRoot}/descriptors/${runtimeId}.json`;
  const descriptorRaw = await readFile(descriptorPath, { encoding: 'utf8', flag: 'r' });
  if (Buffer.byteLength(descriptorRaw) > 4096) throw new Error('descriptor_size');
  const descriptor = parseDescriptor(JSON.parse(descriptorRaw));
  confirmationState = descriptor.intent === 'create' ? 'not_required' : 'waiting';
  await unlink(descriptorPath);
  await setStartupStage('launch');
  const env = zellijEnvironment();
  const sessionName = `matrix-t-${runtimeId}`;
  const paneReleasePath = `${runtimeRoot}/pane-release/${sessionName}`;
  const args = descriptor.intent === 'recover'
    ? ['attach', sessionName]
    : ['--session', sessionName, '--new-session-with-layout', '/opt/matrix/libexec/terminal-runtime/current/spikes/layout.kdl'];
  pty = spawnPty(zellij, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: '/home/matrix/home',
    env,
  });
  pty.onData(async (data) => {
    renderWindow = `${renderWindow}${data}`.slice(-16_384);
    if (!gateRecorded && stripVTControlCharacters(renderWindow).includes('<ENTER> run')) {
      gateRecorded = true;
      confirmationState = 'gated';
      try {
        await writeFile(`${runtimeRoot}/confirmations/${runtimeId}.gated`, '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
        if (code !== 'EEXIST') {
          exit(20);
          return;
        }
      }
      try {
        await recordStartupStage();
      } catch (error) {
        exit(20);
      }
    }
  });
  pty.onExit((event) => {
    clientExited = true;
    clientExitEvent = {
      exitCode: Number.isInteger(event.exitCode) && event.exitCode >= 0 && event.exitCode <= 255
        ? event.exitCode
        : 255,
      signal: Number.isInteger(event.signal) && event.signal >= 0 && event.signal <= 255
        ? event.signal
        : 255,
    };
    if (!stopping && ready) exit(17);
  });
  await setStartupStage('cgroup');
  const cgroup = await ownCgroup();
  await setStartupStage('readiness');
  const deadline = Date.now() + 25_000;
  let roles = null;
  while (Date.now() < deadline) {
    if (clientExited) throw new Error('client_exit');
    const paneReleased = await regularFileExists(paneReleasePath);
    paneReleasedRecorded = paneReleased;
    const responsive = paneReleased && await exactSessionResponds();
    roleSnapshot.responsive = responsive;
    if (paneReleased && responsive && descriptor.intent === 'create' && !workloadPaneLaunched) {
      await launchCreateWorkloadPane(sessionName, env);
    }
    if (descriptor.intent === 'create' && workloadPaneLaunched) {
      workloadPaneState = await inspectWorkloadPane(sessionName, env);
    }
    const detected = paneReleased && (descriptor.intent === 'recover' || workloadPaneLaunched)
      ? await cgroupRoles(cgroup.path, descriptor.intent === 'create')
      : null;
    await recordStartupStage();
    if (paneReleased && responsive && detected && (descriptor.intent === 'create' || gateRecorded)) {
      roles = detected;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!roles) throw new Error('readiness_timeout');
  await setStartupStage('notify');
  await notifyReady();
  await writeReadiness({ runtimeId, sessionName, cgroup: cgroup.relative, roles });
  if (clientExited) throw new Error('client_exit');
  clearTimeout(startupWatchdog);
  startupWatchdog = undefined;
  ready = true;
  let checking = false;
  monitor = setInterval(async () => {
    if (stopping || checking) return;
    checking = true;
    try {
      if (clientExited || !await exactSessionResponds()) exit(18);
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
if (sessionQueryWorkerMode) {
  try {
    await runSessionQueryWorker();
  } catch (error) {
    process.exitCode = 1;
  }
} else {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error && STARTUP_FAILURE_CODES.has(error.message)
      ? error.message
      : 'startup_failed';
    await failStartup(code);
  }
}
