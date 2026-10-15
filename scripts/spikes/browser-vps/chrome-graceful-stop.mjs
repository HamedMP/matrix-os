import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { reportBrowserFailure } from './safe-errors.mjs';

const versionEndpoint = 'http://127.0.0.1:9222/json/version';
const nativeSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateBrowserSocket(value) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid browser socket');
  const url = new URL(value);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== '9222' ||
      url.username || url.password || url.search || url.hash || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new Error('Invalid browser socket');
  return value;
}

async function nativeReadProcess(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], startTime: fields[19] };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}

async function readVersion(response) {
  if (!response.ok || !response.body) throw new Error('Browser version response unavailable');
  const reader = response.body.getReader();
  let bytes = 0; const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 16_384) { await reader.cancel(); throw new Error('Browser version response too large'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

async function issueClose(url, Socket, timeoutMs) {
  const socket = new Socket(url);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', failed);
    };
    const failed = () => { cleanup(); reject(new Error('Browser close connection failed')); };
    const opened = () => {
      try { socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })); cleanup(); resolve(); }
      catch (error) { reportBrowserFailure('chrome_close', error); cleanup(); reject(new Error('Browser close command failed')); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Browser close connection deadline')); }, timeoutMs);
    socket.addEventListener('open', opened);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', failed);
  }).catch(error => { socket.close(); throw error; });
  return socket;
}

export async function stopChrome({ mainPid, fetch = globalThis.fetch, Socket = globalThis.WebSocket,
  readProcess = nativeReadProcess, now = () => performance.now(), sleep = nativeSleep, timeoutMs = 12_000 } = {}) {
  if (!Number.isSafeInteger(mainPid) || mainPid <= 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error('Invalid Chrome stop configuration');
  const deadline = now() + timeoutMs;
  const initial = await readProcess(mainPid);
  if (!initial || initial.state === 'Z') return { status: 'already_stopped' };
  const remaining = () => Math.max(1, deadline - now());
  let socket;
  try {
    const response = await fetch(versionEndpoint, { redirect: 'error', signal: AbortSignal.timeout(Math.ceil(Math.min(3000, remaining()))) });
    const version = await readVersion(response);
    socket = await issueClose(validateBrowserSocket(version.webSocketDebuggerUrl), Socket, Math.min(3000, remaining()));
    // Browser.close requests Chrome's normal shutdown/LevelDB flush. An accepted
    // CDP request alone is insufficient: dbus-run-session must actually exit.
    while (now() < deadline) {
      const current = await readProcess(mainPid);
      if (!current || current.state === 'Z' || current.startTime !== initial.startTime) return { status: 'gracefully_stopped' };
      await sleep(Math.min(50, remaining()));
    }
    throw new Error('Chrome graceful stop deadline');
  } finally {
    if (socket && socket.readyState < 2) socket.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || !/^\d+$/.test(process.argv[2])) throw new Error('Missing systemd main process');
    const result = await stopChrome({ mainPid: Number(process.argv[2]) });
    console.log(`Chrome service stop: ${result.status}`);
  } catch (error) {
    // No CDP payloads/profile data in logs. systemd applies its bounded signal
    // fallback after nonzero ExecStop; profile persistence is then unconfirmed.
    reportBrowserFailure('chrome_close', error, console.error);
    process.exitCode = 1;
  }
}
