#!/usr/bin/env node
import { open, readFile } from 'node:fs/promises';
const home = '/home/matrix/home'; const [operation = '', value = '', extra = '', slot = ''] = process.argv.slice(2);
const runtimeId = /^[0-9a-f]{32}$/.test(value) ? value : null; const failRoleProbe = () => { process.stdout.write('{"error":"probe_roles_global_unknown"}\n'); process.exitCode = 1; }; if (operation === 'roles') { process.once('uncaughtException', failRoleProbe); process.once('unhandledRejection', failRoleProbe); }
const { createAgentConfigurationStore, createOperationId, createSupervisorClient } = ['attach', 'roles'].includes(operation) ? {} : await import('../index.js');
const client = createSupervisorClient?.();
const request = async (name, input, operationId = createOperationId()) => {
  const response = await client.request({
    version: 1, operationId, operation: name, input,
  });
  if (!response.ok) throw new Error(`probe_${response.error.code}`);
  return response.result;
};
const output = (result) => process.stdout.write(`${JSON.stringify(result)}\n`);
const readProcessFile = async (path, fallback) => { try { return await readFile(path, typeof fallback === 'string' ? 'utf8' : undefined); }
  catch (error) { const code = error instanceof Error && 'code' in error ? String(error.code) : ''; if (['ENOENT', 'ESRCH'].includes(code)) return null; if (['EACCES', 'EPERM'].includes(code)) return fallback; throw error; } };
if (operation === 'create' || operation === 'create-race' || operation === 'create-agent') {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('probe_head_invalid'); if (!/^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/.test(extra)) throw new Error('probe_nonce_invalid');
  const operationId = createOperationId(); const configurationStore = createAgentConfigurationStore();
  if (operation === 'create-agent') {
    await configurationStore.publish(operationId, {
      schemaVersion: 1,
      agent: 'pi',
      cwd: { kind: 'home-relative', path: '' },
      mode: 'default',
      approvalPolicy: 'never',
      sandbox: { enabled: false, mode: 'danger-full-access', writableRoots: [], denyWriteRoots: [] },
    });
    try {
      output(await request('CreateStart', {
        displayName: `accept-agent-${value.slice(0, 12)}-${extra}`,
        cwd: { kind: 'home-relative', path: '' },
        launch: { kind: 'agent', configurationRef: operationId },
      }, operationId));
    } catch (error) {
      await configurationStore.remove(operationId);
      throw error;
    }
  } else {
    output(await request('CreateStart', {
      displayName: operation === 'create'
        ? `accept-${value.slice(0, 12)}-${extra}`
        : `accept-race-${value.slice(0, 12)}-${extra}`,
      cwd: { kind: 'home-relative', path: '' },
      launch: { kind: 'shell' },
    }, operationId));
  }
} else if (operation === 'inspect' && runtimeId) {
  output(await request('Inspect', { runtimeId }));
} else if (operation === 'find-shell' || operation === 'find-agent') { if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('probe_head_invalid'); if (!/^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/.test(extra)) throw new Error('probe_nonce_invalid');
  const name = operation === 'find-agent' ? `accept-agent-${value.slice(0, 12)}-${extra}` : `accept-${value.slice(0, 12)}-${extra}`; const runtimes = await request('List', {}); const match = Array.isArray(runtimes) ? runtimes.find((entry) => entry?.displayName === name) : undefined;
  output(match && /^[0-9a-f]{32}$/.test(match.runtimeId) ? { runtimeId: match.runtimeId, lifecycleState: match.lifecycleState } : { runtimeId: null, lifecycleState: 'missing' });
} else if (operation === 'recover' && runtimeId) {
  output(await request('Recover', { runtimeId }));
} else if (operation === 'rename' && runtimeId && /^[a-z0-9-]{1,64}$/.test(extra)) {
  output(await request('RenameMetadata', {
    runtimeId, displayName: extra, baseRevision: 1,
  }));
} else if (operation === 'delete' && runtimeId) {
  output(await request('Delete', { runtimeId }));
} else if (operation === 'concurrent-recover' && runtimeId) {
  const results = await Promise.allSettled([
    request('Recover', { runtimeId }),
    request('Recover', { runtimeId }),
  ]);
  output(results.map((result) => result.status === 'fulfilled'
    ? result.value
    : { error: 'request_failed' }));
} else if (operation === 'recover-delete' && runtimeId) {
  const results = await Promise.allSettled([
    request('Recover', { runtimeId }),
    request('Delete', { runtimeId }),
  ]);
  output(results.map((result) => result.status === 'fulfilled'
    ? result.value
    : { error: 'request_failed' }));
} else if (operation === 'attach' && runtimeId && /^[0-9a-f]{40}$/.test(extra) && /^[12]$/.test(slot)) { const runtimeRoot = `/run/user/${process.getuid()}`; const receipt = `${runtimeRoot}/matrix-terminal-accept-${extra}-${slot}.json`; const { spawn } = await import('node-pty'); const child = spawn('/opt/matrix/bin/zellij', ['attach', `matrix-t-${runtimeId}`], { cwd: home, cols: 120, rows: 40, env: { HOME: home, MATRIX_HOME: home, PATH: `${home}/.local/bin:/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/bin:/bin`, LANG: 'C.UTF-8', TERM: 'xterm-256color', XDG_CACHE_HOME: `${home}/system/terminal-runtime/zellij-cache`, XDG_CONFIG_HOME: `${home}/system/terminal-runtime/zellij-config-home`, XDG_DATA_HOME: `${home}/system/terminal-runtime/zellij-data`, XDG_RUNTIME_DIR: runtimeRoot, ZELLIJ_CONFIG_DIR: '/opt/matrix/libexec/terminal-runtime/current', ZELLIJ_CONFIG_FILE: '/opt/matrix/libexec/terminal-runtime/current/config.kdl' } }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('probe_attach_timeout')), 10_000); child.onData(() => { clearTimeout(timer); resolve(); }); child.onExit(() => { clearTimeout(timer); reject(new Error('probe_attach_exit')); }); }); const cgroup = (await readFile(`/proc/${child.pid}/cgroup`, 'utf8')).split(/\r?\n/).find((line) => line.startsWith('0::'))?.slice(3) ?? ''; const handle = await open(receipt, 'wx', 0o600); await handle.writeFile(`${JSON.stringify({ pid: child.pid, cgroup })}\n`); await handle.close(); const stop = () => child.kill('SIGTERM'); process.once('SIGTERM', stop); process.once('SIGINT', stop); await new Promise((resolve) => child.onExit(resolve));
} else if (operation === 'roles' && runtimeId) { let roleStage = 'systemd'; try {
  const unit = `matrix-terminal-session@${runtimeId}.service`; const { execFile } = await import('node:child_process');
  const show = await new Promise((resolve, reject) => execFile('/usr/bin/systemctl', ['show', unit, '-p', 'ControlGroup', '--value'], { timeout: 5_000, maxBuffer: 16_384 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  roleStage = 'cgroup'; if (show !== `/matrix.slice/matrix-terminal.slice/${unit}`) throw new Error('probe_cgroup_invalid');
  const pids = (await readFile(`/sys/fs/cgroup${show}/cgroup.procs`, 'utf8'))
    .trim().split(/\s+/).filter(Boolean).map(Number); roleStage = 'proc';
  const processes = (await Promise.all(pids.map(async (pid) => { const [comm, raw, stat] = await Promise.all([readProcessFile(`/proc/${pid}/comm`, ''), readProcessFile(`/proc/${pid}/cmdline`, Buffer.alloc(0)), readProcessFile(`/proc/${pid}/stat`, '')]);
    const parent = stat === null ? null : /^\d+\s+\(.*\)\s+\S\s+(\d+)\s/.exec(stat)?.[1]; return comm === null || raw === null || stat === null ? null : { pid, parentPid: parent ? Number(parent) : 0, comm: comm.trim(), args: raw.toString().split('\0').filter(Boolean) };
  }))).filter(Boolean);
  roleStage = 'classify'; const runtimeProcesses = processes.filter((entry) => !(entry.comm === 'zellij' && entry.args.includes('list-sessions'))); const zellij = runtimeProcesses.filter((entry) => entry.comm === 'zellij').sort((left, right) => left.pid - right.pid);
  const keeper = runtimeProcesses.find((entry) => entry.args.some((argument) => argument.endsWith('/keeper.js')));
  const workloads = runtimeProcesses.filter((entry) => entry.pid !== keeper?.pid && !zellij.some((process) => process.pid === entry.pid));
  const namedPane = workloads.find((entry) => entry.args.some((argument) => argument.endsWith('/pane.js'))); const paneCandidates = namedPane ? [namedPane] : workloads.filter((entry) => workloads.some((child) => child.parentPid === entry.pid));
  const pane = paneCandidates.length === 1 ? paneCandidates[0] : undefined; const agentCandidates = pane ? workloads.filter((entry) => entry.parentPid === pane.pid) : []; const paneShell = namedPane ? runtimeProcesses.find((entry) => entry.parentPid === namedPane.pid && entry.comm === 'bash') : undefined; const shell = paneShell ?? runtimeProcesses.find((entry) => entry.comm === 'bash'); const outputCandidates = runtimeProcesses.filter((entry) => entry.comm === 'bash' && entry.pid !== shell?.pid); const outputProcess = outputCandidates.length === 1 ? outputCandidates[0] : undefined; const io = outputProcess ? await readProcessFile(`/proc/${outputProcess.pid}/io`, '') : ''; const match = io === null ? null : /^wchar:\s+([0-9]{1,15})$/m.exec(io); const parsed = match ? Number(match[1]) : 0; const outputWriteBytes = Number.isSafeInteger(parsed) ? parsed : 0;
  output({ processCount: runtimeProcesses.length, keeper: keeper?.pid ?? 0, zellijClient: zellij[0]?.pid ?? 0, zellijServer: zellij[1]?.pid ?? 0, pane: pane?.pid ?? 0, shell: shell?.pid ?? 0, agent: agentCandidates.length === 1 ? agentCandidates[0].pid : 0, output: outputProcess?.pid ?? 0, paneCandidates: paneCandidates.length, agentCandidates: agentCandidates.length, outputCandidates: outputCandidates.length, outputWriteBytes }); } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code).toLowerCase() : ''; const allowed = ['eacces', 'eperm', 'enoent', 'esrch', 'enotdir', 'etimedout'];
    const roleErrorCode = allowed.includes(code) ? code : error instanceof Error && error.message === 'probe_cgroup_invalid' ? 'invalid' : 'unknown'; output({ error: `probe_roles_${roleStage}_${roleErrorCode}` });
  }
} else {
  throw new Error('probe_operation_invalid');
}
