import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod/v4';
import type { RegisteredRuntimeEndpoint } from '../devstack-registered-runtime.js';
import { buildPlatformVerificationToken } from '../platform-token.js';
import { readBoundedHostJson } from '../speech/host-readiness.js';
import type { DevstackRunTarget } from './config.js';

const runTimeoutMs = 120_000;
const responseLimit = 3 * 1024 * 1024;
const logLimit = 64 * 1024;
const chunkBytes = 2048;
const responseSchema = z.object({
  exitCode: z.number().int().min(0).max(255).nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

// The finite runner signals this wrapper on timeout. The wrapper owns the
// command's process group and cleans it up on timeout or leader exit.
const worktreeCommand = String.raw`
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const [root, sha, marker, command, ...args] = process.argv.slice(1);
try {
  if (process.cwd() !== root) process.exit(125);
  const git = flags => execFileSync('git', flags, {
    encoding: 'utf8', timeout: 3000, maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trimEnd();
  if (git(['rev-parse', '--show-toplevel']) !== root ||
      git(['rev-parse', '--verify', 'HEAD']) !== sha) process.exit(125);
} catch (error) {
  if (error instanceof Error) process.exit(125);
  throw error;
}
fs.writeSync(1, marker + '\n');
const child = spawn(command, args, { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
function signalGroup(signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
let escalation;
function terminate() {
  if (escalation) return;
  signalGroup('SIGTERM');
  // Gateway escalates to SIGKILL after five seconds. Finish group cleanup first.
  escalation = setTimeout(() => signalGroup('SIGKILL'), 3_000);
}
process.on('SIGTERM', terminate);
child.once('error', error => process.exit(error.code === 'ENOENT' ? 127 : 126));
child.once('exit', (code, signal) => {
  clearTimeout(escalation);
  signalGroup('SIGKILL');
  process.removeListener('SIGTERM', terminate);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 126);
});
`;

export interface DevstackRunLog {
  stream: 'stdout' | 'stderr';
  text: string;
}
export interface DevstackRunResult {
  status: 'succeeded' | 'failed' | 'timed_out' | 'interrupted' | 'binding_rejected';
  exitCode: number | null;
  logs: DevstackRunLog[];
  truncated: boolean;
}

export function emptyDevstackResult(status: 'binding_rejected' | 'interrupted' | 'timed_out'): DevstackRunResult {
  return { status, exitCode: null, logs: [], truncated: false };
}

function retainOutput(text: string, stream: DevstackRunLog['stream'], logs: DevstackRunLog[]): boolean {
  let used = 0;
  let chunk = '';
  let size = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character);
    if (used + length > logLimit) {
      if (chunk) logs.push({ stream, text: chunk });
      return true;
    }
    if (size + length > chunkBytes) {
      logs.push({ stream, text: chunk });
      chunk = '';
      size = 0;
    }
    chunk += character;
    size += length;
    used += length;
  }
  if (chunk) logs.push({ stream, text: chunk });
  return false;
}

export async function executeDevstackRun(options: {
  endpoint: RegisteredRuntimeEndpoint;
  instance: string;
  target: DevstackRunTarget;
  command: string[];
  platformSecret: string;
  fetch?: typeof fetch;
}): Promise<DevstackRunResult> {
  const { endpoint, instance, target, command, platformSecret, fetch: fetchImpl = fetch } = options;
  const marker = '__devstack_bound_' + randomBytes(16).toString('hex');
  const root = posix.join('/var/lib/matrix-devstack', instance, 'home', target.cwd);
  const response = await fetchImpl(`http://${endpoint.host}:${endpoint.port}/api/terminal/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + buildPlatformVerificationToken(endpoint.handle, platformSecret),
    },
    body: JSON.stringify({
      cwd: target.cwd, timeoutMs: runTimeoutMs,
      command: ['node', '-e', worktreeCommand, '--', root, target.revision, marker, ...command],
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(runTimeoutMs + 10_000),
  });
  if (response.status === 400) {
    await response.body?.cancel();
    return emptyDevstackResult('binding_rejected');
  }
  const result = responseSchema.parse(await readBoundedHostJson(response, responseLimit));
  const prefix = marker + '\n';
  if (!result.stdout.startsWith(prefix)) {
    if (result.timedOut) return emptyDevstackResult('timed_out');
    return emptyDevstackResult(result.exitCode === 125 ? 'binding_rejected' : 'interrupted');
  }
  const logs: DevstackRunLog[] = [];
  const stdoutTruncated = retainOutput(result.stdout.slice(prefix.length), 'stdout', logs);
  const stderrTruncated = retainOutput(result.stderr, 'stderr', logs);
  return {
    status: result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: result.exitCode,
    logs,
    truncated: result.truncated || stdoutTruncated || stderrTruncated,
  };
}
