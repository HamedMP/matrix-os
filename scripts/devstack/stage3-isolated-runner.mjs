import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const commandEnv = { PATH: '/usr/bin:/bin', HOME: '/nonexistent' };
const unavailable = () => new Error('DevStack isolated runner unavailable.');

/** The pinned image contains dependencies only, no operational configuration.
 * The uploaded test runs against a disposable copy. /source stays read-only,
 * preserving inotify/HMR visibility for the separate preview consumer.
 */
export function createIsolatedStage3TestRunner({ image, command, timeoutMs = 90_000 }) {
  if (typeof image !== 'string' || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image)
    || !Array.isArray(command) || !command.length || command.length > 57
    || command.some(arg => typeof arg !== 'string' || !arg || arg.length > 4096 || arg.includes('\0'))
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 90_000 || process.getuid() === 0) throw unavailable();
  command = [...command];
  return async (binding, revision, signal = new AbortController().signal) => {
    signal.throwIfAborted();
    const source = binding.target.root;
    if (!isAbsolute(source) || resolve(source) !== source || /[,\r\n]/.test(source)
      || await realpath(source) !== source || !/^[a-f0-9]{64}$/.test(revision)) throw unavailable();
    const stat = await lstat(source);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw unavailable();
    const name = 'devstack-test-' + randomUUID();
    const uid = process.getuid(), gid = process.getgid();
    const args = ['create', '--pull=never', '--name', name, '--label', 'matrix.devstack.publisher-test=true',
      '--network=none', '--read-only', '--user', `${uid}:${gid}`, '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=128', '--memory=2g', '--cpus=2', '--ulimit', 'core=0', '--ulimit', 'nofile=1024:1024',
      '--mount', `type=bind,src=${source},dst=/source,readonly,bind-recursive=disabled`,
      '--tmpfs', `/work:rw,nosuid,nodev,size=1g,uid=${uid},gid=${gid},mode=0700`,
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '--workdir=/work', '--entrypoint=/usr/bin/env', image,
      '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp', 'CI=1', `DEVSTACK_SOURCE_REVISION=${revision}`,
      '/bin/sh', '-c', 'cp -R /source/. /work/ && exec "$@"', 'devstack-test', ...command];
    let child;
    let timer;
    let timedOut = false;
    let log = Buffer.alloc(0);
    const stop = () => { child?.kill('SIGKILL'); };
    try {
      // Finish creating the inert container before allowing cancellation to
      // interrupt a start. Otherwise a killed `docker run` can create its named
      // container after the cleanup request has already observed it as missing.
      signal.throwIfAborted();
      await exec('/usr/bin/docker', args, { env: commandEnv, timeout: 15_000, maxBuffer: 8192 });
      signal.throwIfAborted();
      const result = await new Promise((resolveResult, reject) => {
        child = spawn('/usr/bin/docker', ['start', '--attach', name], { env: commandEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = chunk => { if (log.length < 64 * 1024) log = Buffer.concat([log, chunk.subarray(0, 64 * 1024 - log.length)]); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('error', () => reject(unavailable()));
        child.once('close', code => {
          if (signal.aborted) return reject(signal.reason);
          resolveResult({ exitCode: timedOut ? 124 : code ?? 1,
            log: timedOut ? 'Test exceeded its time limit.' : log.toString('utf8') || 'No test output.' });
        });
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      });
      if (!timedOut) {
        // Control-plane/OCI failures are not test output. Keep those details
        // private and read the workload's actual exit status from the daemon.
        const { stdout } = await exec('/usr/bin/docker', ['inspect', name, '--format', '{{json .State}}'], {
          env: commandEnv, timeout: 5000, maxBuffer: 8192,
        });
        const state = JSON.parse(stdout);
        if (state.Status !== 'exited' || state.Error || !Number.isInteger(state.ExitCode)
          || state.ExitCode < 0 || state.ExitCode > 255) throw unavailable();
        result.exitCode = state.ExitCode;
      }
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      // Killing the CLI is insufficient: explicitly remove only our container.
      // This runs on normal completion, timeout, cancellation and spawn failure.
      try { await exec('/usr/bin/docker', ['rm', '-f', name], { env: commandEnv, timeout: 10_000, maxBuffer: 8192 }); }
      catch (error) {
        if (!error.stderr?.includes('No such container')) throw unavailable();
      }
    }
  };
}
