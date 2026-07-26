import { execFile as execFileCallback } from 'node:child_process';
import { read } from 'node:fs';
import {
  readFile,
  realpath,
  stat,
} from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod/v4';
import {
  HomeRelativeCwdSchema,
  RuntimeIdSchema,
  createOperationId,
  type HomeRelativeCwd,
} from './contracts.js';
import { createOperationHandler } from './operation-handler.js';
import { createRuntimeState } from './runtime-state.js';
import {
  decodeFrame,
  encodeFrame,
  MAX_FRAME_BYTES,
} from './framing.js';
import {
  decodePeerCredentials,
  handleSupervisorFrame,
} from './supervisor.js';
import {
  classifyRuntimeProcesses,
  createSystemdExecutor,
} from './systemd.js';

const execFile = promisify(execFileCallback);
const HOME = '/home/matrix/home';
const DURABLE_ROOT = `${HOME}/system/terminal-runtime`;
const RUNTIME_ROOT = '/run/matrix-terminal-runtime';
const KeeperRequestSchema = z.object({
  version: z.literal(1),
  runtimeId: RuntimeIdSchema,
}).strict();

async function readPeer(): Promise<ReturnType<typeof decodePeerCredentials>> {
  const bytes = Buffer.alloc(12);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const bytesRead = await new Promise<number>((resolveRead, rejectRead) => {
      read(
        3,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
        (error, count) => {
          if (error) rejectRead(error);
          else resolveRead(count);
        },
      );
    });
    if (bytesRead === 0) throw new Error('peer_credentials_invalid');
    offset += bytesRead;
  }
  return decodePeerCredentials(bytes);
}

async function readRequest(): Promise<Buffer> {
  return await new Promise<Buffer>((resolveRequest, rejectRequest) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const onData = (chunk: Buffer): void => {
      total += chunk.byteLength;
      if (total > MAX_FRAME_BYTES + 4 || chunks.length >= 1_024) {
        finish(new Error('request_too_large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onError = (error: Error): void => finish(error);
    const onEnd = (): void => finish(null);
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('error', onError);
      process.stdin.removeListener('end', onEnd);
      if (error) {
        chunks.length = 0;
        process.stdin.destroy();
        rejectRequest(error);
      } else {
        const request = Buffer.concat(chunks, total);
        chunks.length = 0;
        resolveRequest(request);
      }
    };
    const timer = setTimeout(
      () => finish(new Error('request_timeout')),
      10_000,
    );
    timer.unref();
    process.stdin.on('data', onData);
    process.stdin.once('error', onError);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

async function writeResponse(response: Buffer): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const timer = setTimeout(() => {
      process.stdout.destroy();
      rejectWrite(new Error('response_timeout'));
    }, 10_000);
    timer.unref();
    process.stdout.write(response, (error?: Error | null) => {
      clearTimeout(timer);
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

async function resolveCwd(cwd: HomeRelativeCwd): Promise<HomeRelativeCwd> {
  const parsed = HomeRelativeCwdSchema.parse(cwd);
  const home = await realpath(HOME);
  const target = await realpath(resolve(home, parsed.path));
  if (target !== home && !target.startsWith(`${home}${sep}`)) {
    throw new Error('cwd_unavailable');
  }
  const ownerRelative = relative(home, target);
  return HomeRelativeCwdSchema.parse({
    kind: 'home-relative',
    path: ownerRelative === '' ? '' : ownerRelative,
  });
}

async function belongsToRuntimeCgroup(
  pid: number,
  runtimeId: string,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  const membership = await readFile(`/proc/${pid}/cgroup`, 'utf8');
  const expected = `/matrix-terminal-session@${runtimeId}.service`;
  return membership.split(/\r?\n/).some((line) => {
    if (!line.startsWith('0::')) return false;
    const cgroup = line.slice(3);
    return cgroup.endsWith(expected) && !cgroup.includes('..');
  });
}

async function inspectProcesses(path: string): Promise<{
  keeper: boolean;
  zellijClient: boolean;
  zellijServer: boolean;
  shell: boolean;
}> {
  const pids = (await readFile(`${path}/cgroup.procs`, 'utf8'))
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
  const processes = await Promise.all(pids.map(async (pid) => {
    try {
      const [comm, cmdline] = await Promise.all([
        readFile(`/proc/${pid}/comm`, 'utf8'),
        readFile(`/proc/${pid}/cmdline`),
      ]);
      return {
        comm: comm.trim(),
        args: cmdline.toString('utf8').split('\0').filter(Boolean),
      };
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }));
  return classifyRuntimeProcesses(
    processes.filter((value) => value !== null),
  );
}

async function sessionResponds(runtimeId: string): Promise<boolean> {
  const environment = {
    HOME,
    MATRIX_HOME: HOME,
    PATH: '/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    XDG_CACHE_HOME: `${DURABLE_ROOT}/zellij-cache`,
    XDG_CONFIG_HOME: `${DURABLE_ROOT}/zellij-config-home`,
    XDG_DATA_HOME: `${DURABLE_ROOT}/zellij-data`,
    ZELLIJ_CONFIG_DIR: '/opt/matrix/libexec/terminal-runtime/current',
    ZELLIJ_CONFIG_FILE:
      '/opt/matrix/libexec/terminal-runtime/current/config.kdl',
  };
  try {
    const { stdout } = await execFile(
      '/usr/sbin/runuser',
      [
        '--user',
        'matrix',
        '--',
        '/opt/matrix/bin/zellij',
        'list-sessions',
        '--no-formatting',
      ],
      { env: environment, timeout: 2_000, maxBuffer: 64 * 1024 },
    );
    const expected = `matrix-t-${RuntimeIdSchema.parse(runtimeId)}`;
    return stdout.split(/\r?\n/).some((line) =>
      line.trim().split(/\s+/, 1)[0] === expected);
  } catch (error: unknown) {
    if (error instanceof Error) return false;
    throw error;
  }
}

async function readOwner() {
  const owner = await stat(HOME);
  if (owner.uid === 0) throw new Error('owner_invalid');
  return { uid: owner.uid, gid: owner.gid };
}

async function createHostState(owner: { uid: number; gid: number }) {
  const executor = createSystemdExecutor({
    inspectProcesses: async (path) => await inspectProcesses(path),
    sessionResponds,
  });
  const state = await createRuntimeState({
    durableRoot: DURABLE_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    durableOwner: { uid: owner.uid, gid: owner.gid },
    runtimeOwner: { uid: 0, gid: 0 },
    authorizeDescriptorClaim: async ({ runtimeId, pid }) =>
      await belongsToRuntimeCgroup(pid, runtimeId),
  });
  return { state, executor, owner };
}

async function servePeer(): Promise<void> {
  const peer = await readPeer();
  const owner = await readOwner();
  if (peer.uid !== owner.uid) throw new Error('peer_unauthorized');
  const request = await readRequest();
  const host = await createHostState(owner);
  try {
    const handler = createOperationHandler({
      state: host.state,
      executor: host.executor,
      resolveCwd,
    });
    await writeResponse(await handleSupervisorFrame({
      peer,
      matrixUid: host.owner.uid,
      request,
      handler,
    }));
  } finally {
    await host.state.close();
  }
}

async function serveKeeper(): Promise<void> {
  const peer = await readPeer();
  const owner = await readOwner();
  if (peer.uid !== owner.uid) throw new Error('claim_unauthorized');
  const request = await readRequest();
  const host = await createHostState(owner);
  try {
    const parsed = KeeperRequestSchema.parse(decodeFrame(request));
    const descriptor = await host.state.descriptors.claimRuntime({
      runtimeId: parsed.runtimeId,
      pid: peer.pid,
    });
    await writeResponse(encodeFrame({ ok: true, descriptor }));
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    await writeResponse(encodeFrame({ ok: false, error: 'claim_failed' }));
  } finally {
    await host.state.close();
  }
}

async function maintenance(): Promise<void> {
  let stopping = false;
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolveStop) => {
    resolveStopped = resolveStop;
  });
  const stop = (): void => {
    stopping = true;
    resolveStopped();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  while (!stopping) {
    const host = await createHostState(await readOwner());
    const operationId = createOperationId();
    try {
      const handler = createOperationHandler({
        state: host.state,
        executor: host.executor,
        resolveCwd,
      });
      await handler({
        version: 1,
        operation: 'Reconcile',
        operationId,
        input: {},
      });
      await host.state.descriptors.sweep({
        isActive: async ({ runtimeId }) => {
          const unit = await host.executor.inspect(runtimeId);
          return unit?.unit === 'active' || unit?.unit === 'activating';
        },
        isLocked: async ({ runtimeId }) =>
          await host.state.locks.isRuntimeLocked(runtimeId),
      });
    } finally {
      try {
        await host.state.operations.removeCompleted(operationId);
      } finally {
        await host.state.close();
      }
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      stopped,
      new Promise<void>((resolveDelay) => {
        timer = setTimeout(resolveDelay, 60_000);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

export async function runRuntimeOp(mode: string | undefined): Promise<void> {
  if (mode === 'serve-peer') return await servePeer();
  if (mode === 'serve-keeper') return await serveKeeper();
  if (mode === 'maintenance') return await maintenance();
  throw new Error('runtime_op_invalid');
}

if (process.argv[1]?.endsWith('/runtime-op.js')) {
  try {
    await runRuntimeOp(process.argv[2]);
  } catch (error: unknown) {
    const suffix = error instanceof Error ? '' : '_non_error';
    process.stderr.write(`terminal_runtime_op_failed${suffix}\n`);
    process.exitCode = 1;
  }
}
