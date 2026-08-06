#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const MAX_OUTPUT = 64 * 1024;
const launcherPidPathPattern = /^\/tmp\/matrix-terminal-spike-zellij-delete-(?<headPrefix>[0-9a-f]{5})[0-9a-f]{35}-(?<runId>[1-9][0-9]{0,19})-(?<runAttempt>[1-9][0-9]{0,5})\/op\.[A-Za-z0-9]+\/client\.pid$/;
const resultPathPattern = /^\/tmp\/matrix-terminal-spike-zellij-delete-(?<headPrefix>[0-9a-f]{5})[0-9a-f]{35}-(?<runId>[1-9][0-9]{0,19})-(?<runAttempt>[1-9][0-9]{0,5})\/op\.[A-Za-z0-9]+\/result$/;
const runtimeIdPattern = /^[0-9a-f]{32}$/;
const requestTimeoutPattern = /^[1-9][0-9]?$/;
const terminateWorker = (workerPid) => {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-workerPid, signal);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
        console.error(
          '[terminal-spike] zellij operation worker termination failed:',
          error instanceof Error ? error.name : typeof error,
        );
      }
    }
  }
};
const launchWorker = (launcherPidPath, resultPath, operation, useIpc = false) => {
  const launcherPidHandle = openSync(launcherPidPath, 'wx', 0o600);
  let worker;
  try {
    worker = spawn(process.execPath, [modulePath, '--worker', resultPath, operation], {
      detached: true,
      stdio: useIpc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
    });
    if (!Number.isInteger(worker.pid) || worker.pid < 1) {
      throw new Error('detached_worker_pid_unavailable');
    }
    writeSync(launcherPidHandle, `${worker.pid}\n`);
    worker.unref();
    return worker;
  } catch (error) {
    if (worker?.pid) terminateWorker(worker.pid);
    unlinkSync(launcherPidPath);
    throw error;
  } finally {
    closeSync(launcherPidHandle);
  }
};
const parseWorkerResult = (message) => {
  if (
    message === null
    || typeof message !== 'object'
    || Array.isArray(message)
    || Object.keys(message).sort().join(',') !== 'output,status'
    || !Number.isInteger(message.status)
    || message.status < 0
    || message.status > 255
    || typeof message.output !== 'string'
    || message.output.length > Math.ceil(MAX_OUTPUT / 3) * 4
    || (message.output !== '' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.output))
  ) {
    return null;
  }
  const output = Buffer.from(message.output, 'base64');
  if (output.length > MAX_OUTPUT || output.toString('base64') !== message.output) return null;
  return { status: message.status, output };
};
const waitForWorkerResult = (worker, timeoutSeconds) => new Promise((resolve, reject) => {
  let timer;
  const cleanup = () => {
    clearTimeout(timer);
    worker.removeListener('message', onMessage);
    worker.removeListener('error', onError);
  };
  const onMessage = (message) => {
    const result = parseWorkerResult(message);
    cleanup();
    if (result === null) reject(new Error('invalid_worker_result'));
    else resolve(result);
  };
  const onError = () => {
    cleanup();
    reject(new Error('worker_transport_failed'));
  };
  timer = setTimeout(() => {
    cleanup();
    resolve(null);
  }, timeoutSeconds * 1_000);
  worker.once('message', onMessage);
  worker.once('error', onError);
});

if (process.argv[2] === '--worker') {
  const resultPath = process.argv[3];
  const operation = process.argv[4];
  if (
    !resultPathPattern.test(resultPath)
    || (operation !== '--list' && !runtimeIdPattern.test(operation))
  ) {
    process.exit(2);
  }
  const runIdentity = resultPath.match(resultPathPattern)?.groups;
  if (!runIdentity) process.exit(2);
  const runNamespace = `${runIdentity.headPrefix}${runIdentity.runId.padStart(20, '0')}${runIdentity.runAttempt.padStart(6, '0')}`;
  const ownerUid = statSync('/home/matrix/home').uid;
  if (!Number.isInteger(ownerUid) || ownerUid < 1) {
    process.exit(2);
  }
  const zellijArguments = operation === '--list'
    ? ['list-sessions', '--no-formatting']
    : ['delete-session', `matrix-t-${operation}`, '--force'];
  const child = spawn('/usr/bin/runuser', [
    '-u', 'matrix', '--', '/usr/bin/env',
    'HOME=/home/matrix/home',
    'MATRIX_HOME=/home/matrix/home',
    'PATH=/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/bin:/bin',
    `XDG_CACHE_HOME=/home/matrix/home/system/terminal-runtime-spikes/${runNamespace}/cache`,
    `XDG_CONFIG_HOME=/home/matrix/home/system/terminal-runtime-spikes/${runNamespace}/config-home`,
    `XDG_DATA_HOME=/home/matrix/home/system/terminal-runtime-spikes/${runNamespace}/data`,
    `XDG_RUNTIME_DIR=/run/user/${ownerUid}`,
    `ZELLIJ_CONFIG_DIR=/home/matrix/home/system/terminal-runtime-spikes/${runNamespace}/config`,
    `ZELLIJ_CONFIG_FILE=/home/matrix/home/system/terminal-runtime-spikes/${runNamespace}/config/config.kdl`,
    '/opt/matrix/bin/zellij', ...zellijArguments,
  ], {
    stdio: operation === '--list' ? ['ignore', 'pipe', 'ignore'] : 'ignore',
  });
  let settled = false;
  let outputLength = 0;
  let overflow = false;
  const outputChunks = [];
  child.stdout?.on('data', (chunk) => {
    if (overflow) return;
    outputLength += chunk.length;
    if (outputLength > MAX_OUTPUT) {
      overflow = true;
      child.kill('SIGKILL');
      return;
    }
    outputChunks.push(chunk);
  });
  const publish = async (status, output = Buffer.alloc(0)) => {
    if (settled) return;
    settled = true;
    if (typeof process.send === 'function') {
      try {
        await new Promise((resolve, reject) => {
          process.send({ status, output: output.toString('base64') }, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        process.disconnect();
      } catch (error) {
        console.error(
          '[terminal-spike] zellij operation IPC result failed:',
          error instanceof Error ? error.name : typeof error,
        );
        process.exitCode = 1;
      }
      return;
    }
    const temporary = `${resultPath}.tmp`;
    try {
      await writeFile(
        temporary,
        Buffer.concat([Buffer.from(`${status}\n`), output]),
        { flag: 'wx', mode: 0o600 },
      );
      await rename(temporary, resultPath);
    } catch (error) {
      console.error('[terminal-spike] zellij operation receipt failed:', error instanceof Error ? error.message : typeof error);
      process.exitCode = 1;
    }
  };
  child.once('error', () => {
    void publish(127);
  });
  child.once('close', (code, signal) => {
    const status = overflow
      ? 125
      : signal
        ? 126
        : Number.isInteger(code)
          ? code
          : 127;
    void publish(status, overflow ? Buffer.alloc(0) : Buffer.concat(outputChunks));
  });
} else if (process.argv[2] === '--request') {
  const timeoutText = process.argv[3];
  const timeoutSeconds = Number(timeoutText);
  const launcherPidPath = process.argv[4];
  const resultPath = process.argv[5];
  const operation = process.argv[6];
  if (
    !requestTimeoutPattern.test(timeoutText ?? '')
    || timeoutSeconds > 60
    || !launcherPidPathPattern.test(launcherPidPath ?? '')
    || !resultPathPattern.test(resultPath ?? '')
    || dirname(launcherPidPath) !== dirname(resultPath)
    || (operation !== '--list' && !runtimeIdPattern.test(operation ?? ''))
    || process.argv.length !== 7
  ) {
    process.exit(2);
  }
  let worker;
  let workerPid;
  try {
    worker = launchWorker(launcherPidPath, resultPath, operation, true);
    workerPid = worker.pid;
    const terminateRequest = () => {
      terminateWorker(workerPid);
      process.exit(124);
    };
    process.once('SIGTERM', terminateRequest);
    const result = await waitForWorkerResult(worker, timeoutSeconds);
    process.removeListener('SIGTERM', terminateRequest);
    if (result === null) {
      terminateWorker(workerPid);
      process.exit(124);
    }
    terminateWorker(workerPid);
    writeSync(1, result.output);
    process.exit(result.status);
  } catch (error) {
    if (workerPid) terminateWorker(workerPid);
    console.error(
      '[terminal-spike] bounded zellij operation failed:',
      error instanceof Error ? error.name : typeof error,
    );
    process.exit(127);
  }
} else {
  const launcherPidPath = process.argv[2];
  const resultPath = process.argv[3];
  const operation = process.argv[4];
  if (
    !launcherPidPathPattern.test(launcherPidPath ?? '')
    || !resultPathPattern.test(resultPath ?? '')
    || dirname(launcherPidPath) !== dirname(resultPath)
    || (operation !== '--list' && !runtimeIdPattern.test(operation ?? ''))
  ) {
    process.exit(2);
  }
  try {
    launchWorker(launcherPidPath, resultPath, operation);
  } catch (error) {
    console.error(
      '[terminal-spike] zellij operation launch failed:',
      error instanceof Error ? error.name : typeof error,
    );
    process.exitCode = 1;
  }
  if (process.exitCode) {
    process.exit(process.exitCode);
  }
  process.exit(0);
}
