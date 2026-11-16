import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { connectBrowserCdp, type CdpConnectOptions } from '../../packages/gateway/src/shared-browser/cdp-client.js';

export const PROFILE_HOST = 'matrix-profile-fixture.test';
export interface ProfileState { authenticated: boolean; local: boolean; indexed: boolean; tab: boolean; cookieReadable: boolean; effects: number }

/** Only synthetic booleans/counters enter snapshots; the opaque cookie never does. */
function page(effects: number, seed = false) {
  return `<!doctype html><title>Fixture loading</title><h1>Profile fixture</h1><pre id="state">Loading storage</pre>
<button id="effect">Record one action</button><button id="logout">Log out</button><script>
const seed=${seed};
async function storage(write) {
  return new Promise((resolve,reject)=>{
    const open=indexedDB.open('matrix-profile-fixture',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('markers');
    open.onerror=()=>reject(new Error('Storage unavailable'));
    open.onsuccess=()=>{
      const db=open.result; const tx=db.transaction('markers',write?'readwrite':'readonly');
      const store=tx.objectStore('markers');
      const request=write?store.put('present','marker'):store.get('marker'); let value;
      request.onsuccess=()=>{value=request.result;};
      tx.oncomplete=()=>{db.close();resolve(write||value==='present');};
      tx.onerror=()=>{db.close();reject(new Error('Storage unavailable'));};
    };
  });
}
(async()=>{
  if(seed){localStorage.setItem('matrix-profile-marker','present');sessionStorage.setItem('matrix-tab-marker','present');await storage(true);}
  const protectedResponse=await fetch('/protected',{signal:AbortSignal.timeout(3000),redirect:'error'});
  if(![200,401].includes(protectedResponse.status))throw new Error('Protected fixture unavailable');
  const state={authenticated:protectedResponse.status===200,local:localStorage.getItem('matrix-profile-marker')==='present',indexed:await storage(false),
    tab:sessionStorage.getItem('matrix-tab-marker')==='present',cookieReadable:document.cookie.includes('matrix_profile_fixture='),effects:${effects}};
  document.getElementById('state').textContent=JSON.stringify(state);document.title='Fixture ready';
  for(const action of ['effect','logout'])document.getElementById(action).onclick=async()=>{
    const response=await fetch('/'+action,{method:'POST',signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error('Fixture action unavailable');
    const protectedResponse=await fetch('/protected',{signal:AbortSignal.timeout(3000),redirect:'error'});
    if(![200,401].includes(protectedResponse.status))throw new Error('Protected fixture unavailable');
    const result=await protectedResponse.json();state.authenticated=protectedResponse.status===200;state.effects=result.effects;
    document.getElementById('state').textContent=JSON.stringify(state);
  };
})().catch(()=>{document.getElementById('state').textContent='Storage unavailable';});
</script>`;
}

/** Restrictive local proxy: never forwards traffic; only serves its exact test origin. */
export async function startProfileFixture() {
  let origin = '', session: { token: string; expiresAt: number } | undefined;
  let effects = 0, authenticatedReads = 0, unexpectedTransport: Error | undefined;
  const sockets = new Set<Socket>(); // <=16; close eviction and shutdown drain.
  const server = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    try {
      if (!req.url || req.url.length > 2048) { res.writeHead(400).end(); return; }
      const url = new URL(req.url, origin);
      if (url.origin !== origin || req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
      let bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256) { res.writeHead(413).end(); req.destroy(); return; }
      }
      const supplied = (req.headers.cookie ?? '').match(/(?:^|;\s*)matrix_profile_fixture=([a-f0-9]{48})(?:;|$)/)?.[1];
      const authenticated = !!session && session.expiresAt > Date.now() && supplied === session.token;
      if (req.method === 'GET' && url.pathname === '/owner-grant') {
        session = { token: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000 };
        res.setHeader('Set-Cookie', `matrix_profile_fixture=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(page(effects, true)); return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(page(effects)); return;
      }
      if (req.method === 'GET' && url.pathname === '/protected') {
        if (authenticated) authenticatedReads++;
        res.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ authenticated, effects })); return;
      }
      if (req.method === 'POST' && ['/effect', '/logout'].includes(url.pathname)) {
        if (!authenticated) { res.writeHead(401).end(); return; }
        if (url.pathname === '/effect') effects++;
        else {
          session = undefined;
          res.setHeader('Set-Cookie', 'matrix_profile_fixture=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        }
        res.writeHead(204).end(); return;
      }
      res.writeHead(404).end();
    } catch (error) {
      console.warn('[profile-fixture] Request unavailable', error instanceof Error ? error.name : 'unknown');
      if (!res.headersSent) res.writeHead(500); res.end();
    }
  });
  server.maxConnections = 16; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 32;
  server.on('connection', socket => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      sockets.delete(socket); socket.destroy();
      // Chrome may reset rejected background proxy connections during shutdown.
      if (!['ECONNRESET', 'EPIPE'].includes(error.code ?? '')) unexpectedTransport = error;
    });
  });
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  origin = `http://${PROFILE_HOST}:${address.port}`;
  return {
    origin, proxy: `http://127.0.0.1:${address.port}`,
    stats: () => ({ effects, authenticatedReads }), expire: () => { if (session) session.expiresAt = 0; },
    async close() {
      const stopped = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
      for (const socket of sockets) socket.destroy(); sockets.clear(); await stopped;
      if (unexpectedTransport) throw new Error('Fixture transport failed', { cause: unexpectedTransport });
    },
  };
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function childExit(child: ChildProcess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await pause(25);
  if (child.exitCode === null && child.signalCode === null) throw new Error('Owned Chrome did not exit');
}

/** No existing browser listener/profile is ever selected. The invoked lane fails without Chrome. */
export async function startOwnedProfileChrome(profile: string, proxy: string) {
  const require = createRequire(resolve('packages/mcp-browser/package.json'));
  const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (require('playwright') as typeof import('playwright')).chromium.executablePath();
  await access(executable);
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  if (version.status !== 0) throw new Error('Owned Chrome executable/version unavailable');
  await mkdir(profile, { recursive: true, mode: 0o700 }); await chmod(profile, 0o700);
  // A cleanly stopped process can leave discovery metadata; never read the old port as a new launch.
  try { await unlink(join(profile, 'DevToolsActivePort')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const child = spawn(executable, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-extensions', '--disable-features=MediaRouter', '--disable-default-apps', '--disable-breakpad',
    '--password-store=basic', '--use-mock-keychain', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    // Match Playwright's existing Linux CI launch convention, only for this disposable synthetic fixture.
    ...(process.platform === 'linux' && process.env.CI === 'true' ? ['--no-sandbox'] : []),
    `--user-data-dir=${profile}`, '--restore-last-session',
    `--host-resolver-rules=MAP ${PROFILE_HOST} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    `--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let outputBytes = 0, spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  child.stderr?.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 64 * 1024) child.kill('SIGTERM'); });
  const sockets = new Set<WebSocket>(); // <=8; close eviction and owned shutdown drain.
  let endpoint = '';
  const terminate = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    try { await childExit(child, 3000); }
    catch (error) { child.kill('SIGKILL'); await childExit(child, 3000); if (!(error instanceof Error)) throw error; }
  };
  try {
    const deadline = Date.now() + 10_000;
    while (!endpoint && Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('Owned Chrome startup failed');
      try {
        const bytes = await readFile(join(profile, 'DevToolsActivePort'));
        if (bytes.length > 2048) throw new Error('Owned Chrome endpoint oversized');
        const [port, path] = bytes.toString().trim().split('\n');
        if (/^[0-9]{1,5}$/.test(port!) && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/.test(path!)) endpoint = `http://127.0.0.1:${port}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!endpoint) await pause(25);
    }
    if (!endpoint) throw new Error('Owned Chrome endpoint unavailable');
    const options: CdpConnectOptions = {
      fetcher: async (input, init) => {
        if (String(input) !== 'http://127.0.0.1:9222/json/version') throw new Error('Unexpected CDP discovery');
        const response = await fetch(`${endpoint}/json/version`, { ...init, signal: AbortSignal.timeout(3000), redirect: 'error' });
        if (!response.ok) throw new Error('Owned Chrome discovery unavailable');
        if (!response.body) throw new Error('Owned Chrome discovery unavailable');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try {
          for (;;) {
            const entry = await reader.read(); if (entry.done) break;
            bytes += entry.value.length;
            if (bytes > 16_384) { await reader.cancel(); throw new Error('Owned Chrome discovery oversized'); }
            chunks.push(entry.value);
          }
        } finally { reader.releaseLock(); }
        const value = JSON.parse(Buffer.concat(chunks).toString()) as { webSocketDebuggerUrl?: string };
        const url = new URL(value.webSocketDebuggerUrl ?? '');
        if (url.protocol !== 'ws:' || url.origin !== endpoint.replace('http:', 'ws:') || !/^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/.test(url.pathname)) throw new Error('Unexpected owned CDP endpoint');
        url.port = '9222'; return Response.json({ webSocketDebuggerUrl: url.href });
      },
      socketFactory: value => {
        const url = new URL(value);
        if (url.origin !== 'ws://127.0.0.1:9222' || !/^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/.test(url.pathname) || sockets.size >= 8) throw new Error('Unexpected CDP socket');
        url.port = new URL(endpoint).port;
        const socket = new WebSocket(url.href, { maxPayload: 192 * 1024, handshakeTimeout: 3000 });
        sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket;
      },
    };
    return {
      options, executable, version: version.stdout.trim(), get running() { return child.exitCode === null && child.signalCode === null; },
      async ownerGrant(origin: string) {
        const client = await connectBrowserCdp(options);
        try {
          const target = await client.request('Target.createTarget', { url: `${origin}/owner-grant` });
          const attached = await client.request('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const ready = await client.request('Runtime.evaluate', { expression: "document.title==='Fixture ready'&&sessionStorage.getItem('matrix-tab-marker')==='present'", returnByValue: true }, attached.sessionId);
            if (ready.result?.value === true) { await client.request('Target.closeTarget', { targetId: target.targetId }); return; }
            await pause(25);
          }
          throw new Error('Synthetic owner setup unavailable');
        } finally { await client.close(); }
      },
      disconnect() { for (const socket of sockets) socket.close(); },
      async close() {
        if (child.exitCode === 0) return;
        let failure: unknown;
        try {
          const client = await connectBrowserCdp(options);
          try { await client.request('Browser.close'); }
          finally { await client.close(); }
          await childExit(child, 8000);
          if (child.exitCode !== 0) throw new Error('Owned Chrome did not close cleanly');
        } catch (error) { failure = error; }
        finally {
          for (const socket of sockets) socket.terminate(); sockets.clear();
          await terminate();
        }
        if (failure) throw failure;
      },
    };
  } catch (error) { await terminate(); throw error; }
}
