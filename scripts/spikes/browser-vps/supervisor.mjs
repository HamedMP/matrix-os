import { spawn as nativeSpawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile, mkdir, rm, lstat, chmod } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInvoiceFixture } from './invoices/fixture.mjs';
import { createNativeWindows, parseBrowserControl, parseBrowserSession, InvalidBrowserControl } from './native-windows.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const session = 'matrix-browser-lab';
const socketDirectory = '/tmp/matrix-browser-lab-agent';
const engines = ['agent-browser', 'browser-use'];
const fixtureUrl = 'http://127.0.0.1:8730/fixture';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const executeFile = promisify(execFile);
export async function configureHumanControl(enabled, execute = executeFile) {
  const signal = AbortSignal.timeout(5000);
  const executable = process.env.BROWSER_LAB_VNCCONFIG ?? '/usr/bin/vncconfig';
  const parameters = ['AcceptPointerEvents', 'AcceptKeyEvents'];
  const options = { signal, timeout: 5000, maxBuffer: 1024, env: { HOME: process.env.HOME, PATH: process.env.PATH, DISPLAY: ':7' } };
  const writes = await Promise.allSettled(parameters.map(parameter => execute(executable, ['-display', ':7', '-set', `${parameter}=${enabled ? '1' : '0'}`], options)));
  const failed = writes.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const observed = await Promise.all(parameters.map(parameter => execute(executable, ['-display', ':7', '-get', parameter], options)));
  if (observed.some(({ stdout }) => !(enabled ? ['1', 'true'] : ['0', 'false']).includes(stdout.trim().toLowerCase()))) throw new Error('Viewer input gate verification failed');
}
const procState = async pid => {
  try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
async function waitStopped(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await procState(pid);
    if (!state || state === 'Z') return;
    await sleep(20);
  }
  throw new Error('Automation process did not stop');
}
class ControlRejected extends Error {}

export function parseControl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControlRejected('Invalid control');
  const keys = Object.keys(value).sort().join(',');
  if (value.action === 'start' && keys === 'action,engine' && engines.includes(value.engine)) return value;
  if (['takeover', 'resume', 'stop'].includes(value.action) && keys === 'action') return value;
  throw new ControlRejected('Invalid control');
}

async function terminateWorker(child, engine) {
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await waitStopped(child.pid);
  }
  // CDP attach must disconnect without sending Browser.close to the shared Chrome.
  // Kill only this dedicated daemon; an exit hook must never close Chrome.
  if (engine === 'agent-browser') {
    try {
      const pid = Number(await readFile(join(socketDirectory, `${session}.pid`), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid daemon PID');
      const executable = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      const environment = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
      if (!executable.includes('/agent-browser') || !environment.includes(`AGENT_BROWSER_SESSION=${session}`) ||
          !environment.includes('AGENT_BROWSER_DAEMON=1') || !environment.includes(`AGENT_BROWSER_SOCKET_DIR=${socketDirectory}`)) throw new Error('Unexpected daemon');
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await waitStopped(pid);
      for (const suffix of ['pid', 'sock', 'version', 'log']) await rm(join(socketDirectory, `${session}.${suffix}`), { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // A small barrier lets the kernel reap closed sockets before human input is enabled.
  await sleep(50);
}

export function createSupervisor({ spawn = nativeSpawn, terminate = terminateWorker, setHumanControl = async () => undefined, timeoutMs = 180_000 } = {}) {
  let phase = 'idle', engine = null, generation = 0, worker = null, deadline = null;
  let message = 'Choose a tool to run the synthetic sign-in and work fixture.';
  let checkpoint = 0, workCompleted = 0, epoch = 0, humanControlAvailable = false, closed = false, queue = Promise.resolve();
  let updatedAt = new Date().toISOString();
  const report = error => console.error('Browser lab operation failed:', error instanceof Error ? error.name : 'UnknownError');
  let queuedControls = 0;
  const enqueue = (operation, cleanup = false) => {
    if (!cleanup && queuedControls >= 16) return Promise.reject(new ControlRejected('Supervisor busy'));
    if (!cleanup) queuedControls++;
    const expiresAt = Date.now() + 8000;
    const result = queue.then(() => {
      // Expired waiting requests never perform a late display mutation. Running
      // operations retain the queue until their bounded native calls finish.
      if (!cleanup && Date.now() >= expiresAt) throw new ControlRejected('Control expired');
      return operation();
    }).finally(() => { if (!cleanup) queuedControls--; });
    queue = result.catch(report); return result;
  };
  const update = (nextPhase, nextMessage) => {
    phase = nextPhase; message = nextMessage; updatedAt = new Date().toISOString();
  };
  const status = () => ({ phase, engine, generation, checkpoint, workCompleted, message, updatedAt, humanControlAvailable });
  const gate = async enabled => { humanControlAvailable = false; await setHumanControl(enabled); humanControlAvailable = enabled; };
  const invalidate = async () => {
    generation++; clearTimeout(deadline); deadline = null;
    const previous = worker;
    if (previous) await terminate(previous, engine);
    if (worker === previous) worker = null;
  };
  const disableAndTerminate = async () => {
    let gateError;
    try { await gate(false); } catch (error) { report(error); gateError = error; }
    await invalidate();
    if (gateError) throw gateError;
  };
  const launch = () => {
    const run = ++generation;
    const binary = engine === 'agent-browser' ? process.execPath : '/opt/matrix-browser-lab/venv/bin/python';
    const runner = engine === 'agent-browser' ? 'agent_browser_runner.mjs' : 'browser_use_runner.py';
    worker = spawn(binary, [join(directory, runner), '--observe'], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: directory,
      env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: 'C.UTF-8', DISPLAY: ':7',
        AGENT_BROWSER_NAMESPACE: '', AGENT_BROWSER_SOCKET_DIR: socketDirectory,
        BROWSER_USE_ANONYMIZED_TELEMETRY: 'false', ANONYMIZED_TELEMETRY: 'false',
        BROWSER_USE_LOGGING_LEVEL: 'critical', BROWSER_LAB_FIXTURE_URL: fixtureUrl },
    });
    update('running', 'Observing the current fixture, then continuing from its acknowledged checkpoint.');
    let outputBytes = 0, failureQueued = false;
    const failure = () => {
      if (failureQueued || generation !== run) return Promise.resolve();
      failureQueued = true;
      return enqueue(async () => {
        if (generation !== run) return;
        try { await disableAndTerminate(); update('failed', 'The run stopped. Take over or explicitly resume to try again.'); }
        catch (error) { report(error); update('failed', 'Automation could not be stopped; human control remains unavailable.'); }
      }, true);
    };
    for (const stream of [worker.stdout, worker.stderr]) stream?.on('data', buffer => {
      outputBytes += buffer.length;
      // Never retain, log or forward tool output; it may contain personal page data.
      if (outputBytes > 65_536) void failure();
    });
    worker.once('error', () => { void failure(); });
    worker.once('exit', (code, signal) => {
      if (generation !== run) return;
      clearTimeout(deadline);
      // Keep the child reference until its dedicated daemon is also terminated.
      void enqueue(async () => {
        if (generation !== run) return;
        try {
          await disableAndTerminate();
          const completed = code === 0 && !signal && checkpoint === 3;
          if (completed) await gate(true);
          update(completed ? 'completed' : 'failed', completed ? 'Fixture completed. Chrome and its profile remain available.' : 'The run stopped. Take over to control the browser, then explicitly resume.');
        } catch (error) { report(error); update('failed', 'Automation cleanup failed; review the test service before continuing.'); }
      }, true);
    });
    deadline = setTimeout(() => { void failure(); }, timeoutMs);
    deadline.unref?.();
  };
  const perform = async input => {
    if (closed) throw new ControlRejected('Supervisor closed');
    const action = parseControl(input);
    if (action.action === 'start') {
      if (!['idle', 'stopped', 'completed', 'failed'].includes(phase)) throw new ControlRejected('Stop or resume the current run first');
      await gate(false); await invalidate(); engine = action.engine; epoch++; checkpoint = 0; workCompleted = 0; launch();
    } else if (action.action === 'takeover') {
      await disableAndTerminate(); await gate(true); update('human', 'Automation is disconnected. You can control Chrome. Already-issued website actions may still finish.');
    } else if (action.action === 'resume') {
      if (!engine || !['human', 'failed', 'stopped'].includes(phase)) throw new ControlRejected('No stopped run to resume');
      await gate(false); await invalidate(); launch();
    } else {
      await disableAndTerminate(); await gate(true); update('stopped', 'Automation stopped. Your Chrome profile is preserved.');
    }
    return status();
  };
  return {
    status,
    control(input, after = value => value) {
      if (closed) return Promise.reject(new ControlRejected('Supervisor closed'));
      return enqueue(async () => { try { return await after(await perform(input)); } catch (error) { if (!(error instanceof ControlRejected)) update('failed', 'The control action failed. Human input remains unavailable until cleanup and gating succeed.'); throw error; } });
    },
    automationInput(enabled) {
      if (closed || typeof enabled !== 'boolean') return Promise.reject(new ControlRejected('Invalid automation input'));
      return enqueue(async () => {
        await disableAndTerminate();
        engine = null;
        if (enabled) await gate(true);
        update(enabled ? 'human' : 'external', enabled ? 'You control Chrome.' : 'Matrix Chat controls Chrome.');
        return { humanControlAvailable };
      });
    },
    observe(operation) {
      if (closed) return Promise.reject(new ControlRejected('Supervisor closed'));
      return enqueue(operation);
    },
    fixture() { return { epoch, generation, checkpoint, workCompleted, otp: totp() }; },
    fixtureAction(action) {
      if (!Number.isSafeInteger(action.epoch) || action.epoch !== epoch) throw new Error('Stale fixture epoch');
      if (action.action === 'login' && checkpoint === 0 && action.username === 'matrix-lab' && action.password === 'synthetic-only') checkpoint = 1;
      else if (action.action === 'verify' && checkpoint === 1 && validOtp(action.otp)) checkpoint = 2;
      else if (action.action === 'work' && checkpoint === 2 && action.expected === workCompleted) {
        workCompleted++; if (workCompleted === 10) checkpoint = 3;
      } else throw new Error('Fixture action rejected');
      updatedAt = new Date().toISOString(); return { epoch, generation, checkpoint, workCompleted };
    },
    async close() { closed = true; await queue; await disableAndTerminate(); update('stopped', 'Test service closed.'); },
  };
}

function totp(offset = 0) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const hmac = createHmac('sha1', 'matrix-browser-lab-synthetic-totp').update(counter).digest();
  const position = hmac[19] & 15;
  return String((hmac.readUInt32BE(position) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
function validOtp(value) {
  return typeof value === 'string' && /^\d{6}$/.test(value) && [-1, 0, 1].some(offset => timingSafeEqual(Buffer.from(value), Buffer.from(totp(offset))));
}
async function body(request) {
  let count = 0; const chunks = [];
  for await (const chunk of request) {
    count += chunk.length;
    if (count > 1024) { const error = new Error('Too large'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function fixtureSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid fixture');
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) throw new Error('Invalid fixture epoch');
  const keys = Object.keys(value).sort().join(',');
  if (value.action === 'login' && keys === 'action,epoch,password,username' && typeof value.username === 'string' && typeof value.password === 'string' && value.username.length < 64 && value.password.length < 64) return value;
  if (value.action === 'verify' && keys === 'action,epoch,otp' && typeof value.otp === 'string' && /^\d{6}$/.test(value.otp)) return value;
  if (value.action === 'work' && keys === 'action,epoch,expected' && Number.isInteger(value.expected) && value.expected >= 0 && value.expected < 10) return value;
  throw new Error('Invalid fixture');
}

export function createLabServer(supervisor, staticDirectory, nativeWindows = createNativeWindows()) {
  const invoices = createInvoiceFixture({ requireOwnerLogin: process.env.BROWSER_LAB_INVOICE_HANDOFF === 'true' });
  return createServer(async (request, response) => {
    const json = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
    let productOperation = false;
    try {
      if (!['127.0.0.1:8730', 'localhost:8730'].includes(request.headers.host)) return json(403, { error: 'Request denied' });
      const url = new URL(request.url, 'http://127.0.0.1:8730');
      const invoice = await invoices.respond(request, url);
      if (invoice) { response.writeHead(invoice.status, invoice.headers); return response.end(invoice.body); }
      productOperation = ['/browser-status', '/browser-control', '/browser-session', '/browser-observe', '/automation-input'].includes(url.pathname);
      if (request.method === 'POST' && request.headers['content-type']?.split(';')[0] !== 'application/json') return json(415, { error: 'JSON required' });
      if (request.method === 'GET' && url.pathname === '/status') return json(200, supervisor.status());
      if (request.method === 'POST' && url.pathname === '/control') return json(200, await supervisor.control(parseControl(await body(request))));
      if (request.method === 'GET' && url.pathname === '/browser-status') return json(200, { ...await nativeWindows.status(), humanControlAvailable: supervisor.status().humanControlAvailable });
      if (request.method === 'POST' && url.pathname === '/automation-input') {
        const input = await body(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'enabled' || typeof input.enabled !== 'boolean') return json(400, { error: 'Invalid input gate' });
        return json(200, await supervisor.automationInput(input.enabled));
      }
      if (request.method === 'POST' && url.pathname === '/browser-observe') {
        const { surface } = parseBrowserSession(await body(request));
        const status = await supervisor.observe(async () => ({ ...await (surface === 'browser' ? nativeWindows.control({ action: 'restore-chrome' }) : nativeWindows.status()), humanControlAvailable: supervisor.status().humanControlAvailable }));
        return json(200, status);
      }
      if (request.method === 'POST' && url.pathname === '/browser-control') {
        const action = parseBrowserControl(await body(request));
        const status = await supervisor.control({ action: 'takeover' }, async () => ({ ...await nativeWindows.control(action), humanControlAvailable: supervisor.status().humanControlAvailable }));
        return json(200, status);
      }
      if (request.method === 'POST' && url.pathname === '/browser-session') {
        const { surface } = parseBrowserSession(await body(request));
        const status = await supervisor.control({ action: 'takeover' }, async () => ({ ...await (surface === 'browser' ? nativeWindows.control({ action: 'restore-chrome' }) : nativeWindows.status()), humanControlAvailable: supervisor.status().humanControlAvailable }));
        return json(200, status);
      }
      if (request.method === 'GET' && url.pathname === '/fixture/status') return json(200, supervisor.fixture());
      if (request.method === 'POST' && url.pathname === '/fixture/action') return json(200, supervisor.fixtureAction(fixtureSchema(await body(request))));
      if (request.method === 'GET' && (url.pathname === '/fixture' || /^\/assets\/[a-zA-Z0-9._-]+$/.test(url.pathname))) {
        const path = url.pathname === '/fixture' ? join(staticDirectory, 'index.html') : join(staticDirectory, url.pathname);
        const file = await readFile(path); // Dist assets are fixed, bounded build output.
        if (file.length > 2_000_000) throw new Error('Asset too large');
        response.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        return response.end(file);
      }
      json(404, { error: 'Not found' });
    } catch (error) {
      const status = error.status === 413 ? 413 : productOperation && !(error instanceof SyntaxError) && !(error instanceof InvalidBrowserControl) ? 502 : 400;
      if (status === 502) console.warn('Native browser action unavailable:', error instanceof Error ? error.name : 'UnknownError');
      json(status, { error: 'The test request could not be completed.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  const socketStat = await lstat(socketDirectory);
  if (!socketStat.isDirectory() || socketStat.isSymbolicLink() || socketStat.uid !== process.getuid()) throw new Error('Unsafe socket directory');
  await chmod(socketDirectory, 0o700);
  await configureHumanControl(false);
  const supervisor = createSupervisor({ setHumanControl: configureHumanControl });
  const server = createLabServer(supervisor, process.env.BROWSER_LAB_STATIC_DIR ?? join(directory, 'lab/dist'));
  server.requestTimeout = 10_000; server.headersTimeout = 5000; server.timeout = 10_000;
  server.maxConnections = 32;
  server.listen(8730, '127.0.0.1');
  const shutdown = async () => {
    server.close();
    try { await supervisor.close(); }
    catch (error) { console.error('Browser lab shutdown failed:', error instanceof Error ? error.name : 'UnknownError'); process.exitCode = 1; }
    finally { server.closeAllConnections(); }
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}
