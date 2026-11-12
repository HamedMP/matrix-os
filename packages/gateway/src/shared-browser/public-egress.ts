import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { connect, Socket, type AddressInfo } from 'node:net';
import { validateBrowserUrl, type BrowserResolver } from './url-policy.js';

const AUTHORITY = /^(?:[a-z0-9.-]{1,253}|\[[a-f0-9:.]{2,45}\]):443$/i;
const MAX_CLIENTS = 64;
const MAX_INITIAL_BYTES = 16_384;
const HANDSHAKE_MS = 5000;
const IDLE_MS = 45_000;
type Destination = { host: string; family: number; port: 443 };

async function publicDestination(authority: string, resolveHost: BrowserResolver): Promise<Destination | undefined> {
  if (!AUTHORITY.test(authority)) return;
  let addresses: Awaited<ReturnType<BrowserResolver>> = [];
  try {
    const checked = await validateBrowserUrl(`https://${authority}/`, async hostname => {
      addresses = await resolveHost(hostname);
      return addresses;
    });
    const address = addresses.find(entry => entry.family === 4) ?? addresses[0];
    if (checked.fixture || !address) return;
    return { host: address.address, family: address.family, port: 443 };
  } catch (error) {
    if (!(error instanceof Error)) console.warn('[shared-browser] Public egress authority validation failed');
    return undefined;
  }
}

/** HTTPS tunnels for the opt-in public context. No cookies, auth, or request
 * bodies are parsed, logged or retained. The gateway owns the listener. */
export async function startPublicBrowserEgress(options: {
  resolveHost?: BrowserResolver;
  dial?: (destination: Destination) => Socket;
} = {}): Promise<{ port: number; close(): Promise<void> }> {
  const resolveHost = options.resolveHost ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  const dial = options.dial ?? (destination => connect(destination));
  const clients = new Set<Socket>(); // Bounded by admission and close/timeout eviction.
  let closing: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 4096, headersTimeout: HANDSHAKE_MS, requestTimeout: HANDSHAKE_MS }, (_request, response) => {
    response.writeHead(403, { connection: 'close', 'content-length': '0' });
    response.end();
  });
  server.maxConnections = MAX_CLIENTS;
  server.setTimeout(HANDSHAKE_MS, socket => socket.destroy());
  server.on('connection', socket => {
    if (closing || clients.size >= MAX_CLIENTS) { socket.destroy(); return; }
    clients.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => clients.delete(socket));
  });
  server.on('connect', (request, stream, head) => {
    if (!(stream instanceof Socket) || !clients.has(stream) || closing) { stream.destroy(); return; }
    const client = stream;
    const reject = (status: '403 Forbidden' | '502 Bad Gateway') => {
      if (!client.destroyed) client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    client.pause();
    if (head.length > MAX_INITIAL_BYTES) { reject('403 Forbidden'); return; }
    void (async () => {
      const destination = await publicDestination(request.url ?? '', resolveHost);
      if (client.destroyed || closing) return;
      if (!destination) { reject('403 Forbidden'); return; }
      const upstream = dial(destination);
      let connected = false;
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => { if (connected) client.destroy(); else reject('502 Bad Gateway'); });
      upstream.on('error', () => upstream.destroy());
      upstream.setTimeout(HANDSHAKE_MS, () => upstream.destroy());
      upstream.once('connect', () => {
        if (client.destroyed || closing) { upstream.destroy(); return; }
        connected = true;
        client.setTimeout(IDLE_MS, () => client.destroy());
        upstream.setTimeout(IDLE_MS, () => upstream.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    })().catch((error: unknown) => {
      console.warn('[shared-browser] Public egress tunnel failed', error instanceof Error ? 'operation_failed' : 'unexpected_failure');
      reject('502 Bad Gateway');
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListen); reject(error); };
    const onListen = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(0, '127.0.0.1');
  });
  server.on('error', () => console.warn('[shared-browser] Public egress listener unavailable'));
  const { port } = server.address() as AddressInfo;
  return { port, close: () => {
    if (closing) return closing;
    closing = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const socket of clients) socket.destroy();
    });
    return closing;
  } };
}
