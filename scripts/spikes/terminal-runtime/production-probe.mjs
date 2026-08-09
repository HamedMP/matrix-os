#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  createAgentConfigurationStore,
  createOperationId,
  createSupervisorClient,
} from '../index.js';
const home = '/home/matrix/home';
const [operation = '', value = '', extra = ''] = process.argv.slice(2);
const runtimeId = /^[0-9a-f]{32}$/.test(value) ? value : null;
const client = createSupervisorClient();
const request = async (name, input, operationId = createOperationId()) => {
  const response = await client.request({
    version: 1, operationId, operation: name, input,
  });
  if (!response.ok) throw new Error(`probe_${response.error.code}`);
  return response.result;
};
const output = (result) => process.stdout.write(`${JSON.stringify(result)}\n`);
if (operation === 'create' || operation === 'create-race' ||
    operation === 'create-agent') {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('probe_head_invalid');
  if (!/^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/.test(extra)) throw new Error('probe_nonce_invalid');
  const operationId = createOperationId();
  const configurationStore = createAgentConfigurationStore();
  if (operation === 'create-agent') {
    await configurationStore.publish(operationId, {
      schemaVersion: 1,
      agent: 'pi',
      cwd: { kind: 'home-relative', path: '' },
      mode: 'default',
      approvalPolicy: 'never',
      sandbox: {
        enabled: false,
        mode: 'danger-full-access',
        writableRoots: [],
        denyWriteRoots: [],
      },
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
} else if (operation === 'find-shell') {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('probe_head_invalid');
  if (!/^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/.test(extra)) throw new Error('probe_nonce_invalid');
  const name = `accept-${value.slice(0, 12)}-${extra}`;
  const runtimes = await request('List', {});
  const match = Array.isArray(runtimes)
    ? runtimes.find((entry) => entry?.displayName === name) : undefined;
  output(match && /^[0-9a-f]{32}$/.test(match.runtimeId)
    ? { runtimeId: match.runtimeId, lifecycleState: match.lifecycleState }
    : { runtimeId: null, lifecycleState: 'missing' });
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
} else if (operation === 'roles' && runtimeId) {
  const unit = `matrix-terminal-session@${runtimeId}.service`;
  const { execFile } = await import('node:child_process');
  const show = await new Promise((resolve, reject) => execFile(
    '/usr/bin/systemctl',
    ['show', unit, '-p', 'ControlGroup', '--value'],
    { timeout: 5_000, maxBuffer: 16_384 },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()),
  ));
  if (!show.endsWith(`/${unit}`) || show.includes('..')) {
    throw new Error('probe_cgroup_invalid');
  }
  const pids = (await readFile(`/sys/fs/cgroup${show}/cgroup.procs`, 'utf8'))
    .trim().split(/\s+/).filter(Boolean).map(Number);
  const processes = (await Promise.all(pids.map(async (pid) => {
    try {
      const [comm, raw, status] = await Promise.all([
        readFile(`/proc/${pid}/comm`, 'utf8'),
        readFile(`/proc/${pid}/cmdline`),
        readFile(`/proc/${pid}/status`, 'utf8'),
      ]);
      return { pid, parentPid: Number(status.match(/^PPid:\s+(\d+)$/m)?.[1] ?? 0), comm: comm.trim(), args: raw.toString().split('\0').filter(Boolean) };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }))).filter(Boolean);
  const zellij = processes.filter((entry) =>
    entry.comm === 'zellij' && !entry.args.includes('list-sessions'))
    .sort((left, right) => left.pid - right.pid);
  const pane = processes.find((entry) => entry.args.some((argument) =>
    argument.endsWith('/pane.js')));
  output({
    processCount: processes.length,
    keeper: processes.find((entry) =>
      entry.args.some((argument) => argument.endsWith('/keeper.js')))?.pid ?? 0,
    zellijClient: zellij[0]?.pid ?? 0,
    zellijServer: zellij[1]?.pid ?? 0,
    pane: pane?.pid ?? 0,
    shell: processes.find((entry) => entry.comm === 'bash')?.pid ?? 0,
    agent: processes.find((entry) => entry.parentPid === pane?.pid)?.pid ?? 0,
  });
} else {
  throw new Error('probe_operation_invalid');
}
