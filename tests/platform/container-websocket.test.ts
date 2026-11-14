import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { registerPlatformWebSocketUpgradeHandler } from '../../packages/platform/src/platform-websocket-upgrade.js';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import type { ContainerProvider, ContainerUnit } from '../../packages/platform/src/substrates/container-provider.js';
import { createContainerSubstrate } from '../../packages/platform/src/substrates/container-substrate.js';
import {
  buildContainerSubprotocols,
  relayContainerWebSocket,
  sanitizeUpstreamHandshake,
} from '../../packages/platform/src/substrates/container-websocket.js';
import type { Socket } from 'node:net';
import { createSubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import { createVpsSubstrate } from '../../packages/platform/src/substrates/vps-substrate.js';
import { JWT_SECRET, cleanupProxyRoutingTest, setupProxyRoutingTest } from './proxy-routing-test-utils.js';

const tls = vi.hoisted(() => ({ upstreams: [] as Array<EventEmitter & { writes: string[]; options: unknown; destroyed: boolean }> }));
vi.mock('node:tls', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Upstream extends Emitter {
    writes: string[] = [];
    destroyed = false;
    constructor(readonly options: unknown) { super(); }
    write(value: string | Buffer) { this.writes.push(String(value)); return true; }
    pipe() { return this; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } return this; }
  }
  return {
    connect: (options: unknown, onConnect: () => void) => {
      const upstream = new Upstream(options);
      tls.upstreams.push(upstream as never);
      queueMicrotask(onConnect);
      return upstream;
    },
  };
});

class ClientSocket extends EventEmitter {
  writes: string[] = [];
  ended: string[] = [];
  destroyed = false;
  writable = true;
  write(value: string | Buffer) { this.writes.push(String(value)); return true; }
  end(value?: string, callback?: () => void) {
    if (value !== undefined) this.ended.push(value);
    this.writable = false;
    setImmediate(() => callback?.());
    return this;
  }
  pipe() { return this; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.writable = false; this.emit('close'); } return this; }
}

const ENDPOINT = 'mvm-1.lambda-microvm.eu-west-1.on.aws';
const TOKEN = 'provider-token-abc123';
const OWNER = 'user_owner';

function fakeProvider(): ContainerProvider {
  const unit: ContainerUnit = { unitId: 'mvm-1', state: 'pending', endpointHost: ENDPOINT, createdAt: new Date(),
    expiresAt: new Date(Date.now() + 8 * 3_600_000) };
  return {
    run: vi.fn(async () => unit), suspend: vi.fn(async () => undefined), resume: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined), describe: vi.fn(async () => null), list: vi.fn(async () => []),
    mintEndpointCredential: vi.fn(async () => ({
      headers: { 'X-aws-proxy-auth': TOKEN, 'X-aws-proxy-port': '4000' }, expiresAt: new Date(Date.now() + 1_800_000),
    })),
  };
}

describe('container WebSocket subprotocols', () => {
  const upstream = { url: 'https://x', hostHeader: ENDPOINT, headers: { 'X-aws-proxy-auth': TOKEN, 'X-aws-proxy-port': '4000' } };

  it('puts provider authentication first and keeps the client protocols in order', () => {
    expect(buildContainerSubprotocols(upstream, 'matrix.v2, chat')).toBe(
      `lambda-microvms, lambda-microvms.authentication.${TOKEN}, lambda-microvms.port.4000, matrix.v2, chat`);
    expect(buildContainerSubprotocols(upstream, undefined))
      .toBe(`lambda-microvms, lambda-microvms.authentication.${TOKEN}, lambda-microvms.port.4000`);
  });

  it('drops provider-looking protocols a client tries to inject', () => {
    expect(buildContainerSubprotocols(upstream, 'lambda-microvms.authentication.forged, chat'))
      .toBe(`lambda-microvms, lambda-microvms.authentication.${TOKEN}, lambda-microvms.port.4000, chat`);
  });

  it('refuses to build protocols without a usable credential', () => {
    expect(buildContainerSubprotocols({ ...upstream, headers: {} }, 'chat')).toBeNull();
    expect(buildContainerSubprotocols({ ...upstream, headers: { 'X-aws-proxy-auth': 'bad token', 'X-aws-proxy-port': '4000' } }, 'chat')).toBeNull();
  });

  it('removes provider protocols and the token from the handshake answer, keeping the client protocol', () => {
    const head = [
      'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: abc=',
      `Sec-WebSocket-Protocol: lambda-microvms.authentication.${TOKEN}, chat`, `X-Debug: ${TOKEN}`,
    ].join('\r\n');
    const clean = sanitizeUpstreamHandshake(head, TOKEN);
    expect(clean).not.toContain(TOKEN);
    expect(clean).not.toContain('lambda-microvms');
    expect(clean).toContain('Sec-WebSocket-Protocol: chat');
    expect(clean).toContain('Sec-WebSocket-Accept: abc=');
  });

  it('drops the protocol header entirely when only the provider protocol was selected', () => {
    const clean = sanitizeUpstreamHandshake('HTTP/1.1 101 Switching Protocols\r\nsec-websocket-protocol: lambda-microvms', TOKEN);
    expect(clean).toBe('HTTP/1.1 101 Switching Protocols');
  });
});

describe('container WebSocket upgrades through the platform', () => {
  let db: PlatformDB;
  let provider: ContainerProvider;
  let lifecycle: ReturnType<typeof createContainerLifecycleService>;

  beforeEach(async () => {
    db = await setupProxyRoutingTest();
    tls.upstreams.length = 0;
    provider = fakeProvider();
    lifecycle = createContainerLifecycleService({ db, provider, buildBootPayload: async () => '{}' });
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'owner-handle', status: 'stopped', imageVersion: null,
      provisionedAt: new Date().toISOString(), substrate: 'container',
    });
  });
  afterEach(async () => { await lifecycle.shutdown(); await cleanupProxyRoutingTest(db); });

  function listen() {
    const server = new EventEmitter();
    const container = createContainerSubstrate({
      lifecycle, provider, endpointHostSuffix: '.on.aws', loadMachine: (machineId) => getUserMachine(db, machineId),
    });
    const decision = { runtimeProxyAllowed: true } as never;
    registerPlatformWebSocketUpgradeHandler({
      server: server as Server, app: { capturePlatformEvent: vi.fn() }, db, env: {},
      platformSecret: 'platform-secret-container-ws', platformJwtSecret: JWT_SECRET, legacyContainerRoutingEnabled: false,
      codeServerPort: 8080, getRuntimeEntitlementDecision: () => decision, getRuntimeEntitlementDecisionForUser: async () => decision,
      substrates: createSubstrateRegistry([createVpsSubstrate({ loadMachine: async () => undefined }), container]),
    });
    return server.listeners('upgrade')[0] as (req: IncomingMessage, socket: ClientSocket, head: Buffer) => Promise<void>;
  }

  async function token(sub = OWNER) {
    return (await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: sub, handle: 'owner-handle', gatewayUrl: 'https://app.matrix-os.com' })).token;
  }

  async function upgrade(listener: ReturnType<typeof listen>, headers: Record<string, string>, url = '/ws') {
    const socket = new ClientSocket();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await listener({ method: 'GET', url, headers: { host: 'app.matrix-os.com', upgrade: 'websocket', ...headers } } as unknown as IncomingMessage,
        socket, Buffer.alloc(0));
    } finally { warn.mockRestore(); }
    return socket;
  }

  const statusLine = (socket: ClientSocket) => [...socket.writes, ...socket.ended].join('').split('\r\n')[0];

  async function makeRunning() {
    await lifecycle.ensureStarted('ctr-1');
    await lifecycle.drain();
    const machine = await getUserMachine(db, 'ctr-1');
    expect(await lifecycle.markRegistered('ctr-1', machine!.generation)).toBe('ok');
  }

  it('wakes a stopped container for its owner and answers 503 until it runs', async () => {
    const socket = await upgrade(listen(), { authorization: `Bearer ${await token()}` });
    expect(statusLine(socket)).toBe('HTTP/1.1 503 Service Unavailable');
    await lifecycle.drain();
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(tls.upstreams).toHaveLength(0);
  });

  it('never starts compute for another user or a signed-out upgrade', async () => {
    const listener = listen();
    expect(statusLine(await upgrade(listener, { authorization: `Bearer ${await token('user_other')}` }))).not.toContain('101');
    expect(statusLine(await upgrade(listener, {}))).toBe('HTTP/1.1 401 Unauthorized');
    await lifecycle.drain();
    expect(provider.run).not.toHaveBeenCalled();
  });

  it('connects a running container with provider subprotocols and returns a clean handshake', async () => {
    await makeRunning();
    const socket = await upgrade(listen(), {
      authorization: `Bearer ${await token()}`, 'sec-websocket-protocol': 'matrix.v2', 'x-aws-proxy-auth': 'client-forged',
    });
    await vi.waitFor(() => expect(tls.upstreams.at(-1)?.writes.length).toBeGreaterThan(0));
    const upstream = tls.upstreams.at(-1)!;
    expect(upstream.options).toMatchObject({ host: ENDPOINT, port: 443, servername: ENDPOINT, rejectUnauthorized: true });
    const request = upstream.writes[0]!;
    expect(request.startsWith('GET /ws HTTP/1.1\r\nHost: ' + ENDPOINT + '\r\n')).toBe(true);
    expect(request).toContain(`Sec-WebSocket-Protocol: lambda-microvms, lambda-microvms.authentication.${TOKEN}, lambda-microvms.port.4000, matrix.v2\r\n`);
    expect(request.match(/sec-websocket-protocol/gi)).toHaveLength(1);
    expect(request).not.toContain('client-forged');
    expect(request.endsWith('\r\n\r\n')).toBe(true);

    upstream.emit('data', Buffer.from(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Protocol: lambda-microvms.authentication.${TOKEN}, matrix.v2`, '', 'frame'].join('\r\n')));
    const written = socket.writes.join('');
    expect(written.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true);
    expect(written).toContain('Sec-WebSocket-Protocol: matrix.v2\r\n\r\nframe');
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain('lambda-microvms');
  });

  it('sends the row\'s compute mode on the upgrade and replaces a client-sent value', async () => {
    await makeRunning();
    await upgrade(listen(), { authorization: `Bearer ${await token()}`, 'x-matrix-compute-mode': 'export_only' });
    await vi.waitFor(() => expect(tls.upstreams.at(-1)?.writes.length).toBeGreaterThan(0));
    const request = tls.upstreams.at(-1)!.writes[0]!;
    expect(request.match(/x-matrix-compute-mode/gi)).toHaveLength(1);
    expect(request).toContain('\r\nx-matrix-compute-mode: full\r\n');
  });

  it('answers 502 instead of relaying an oversized handshake', async () => {
    await makeRunning();
    const socket = await upgrade(listen(), { authorization: `Bearer ${await token()}` });
    await vi.waitFor(() => expect(tls.upstreams.at(-1)?.writes.length).toBeGreaterThan(0));
    tls.upstreams.at(-1)!.emit('data', Buffer.alloc(20_000, 'a'));
    expect(statusLine(socket)).toBe('HTTP/1.1 502 Bad Gateway');
    expect(socket.writes.join('')).not.toContain('aaaa');
  });

  it('answers 502 for an oversized handshake whose last chunk carries the header terminator', async () => {
    await makeRunning();
    const socket = await upgrade(listen(), { authorization: `Bearer ${await token()}` });
    await vi.waitFor(() => expect(tls.upstreams.at(-1)?.writes.length).toBeGreaterThan(0));
    const oversized = `HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${'a'.repeat(20_000)}\r\n\r\n`;
    tls.upstreams.at(-1)!.emit('data', Buffer.from(oversized, 'latin1'));
    expect(statusLine(socket)).toBe('HTTP/1.1 502 Bad Gateway');
    expect(socket.writes.join('')).not.toContain('aaaa');
  });
});

describe('container WebSocket handshake deadline', () => {
  class HangingUpstream extends EventEmitter {
    writes: string[] = [];
    destroyed = false;
    write(value: string | Buffer) { this.writes.push(String(value)); return true; }
    pipe() { return this; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } return this; }
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function relay(options: { answerConnect: boolean }) {
    const upstream = new HangingUpstream();
    const client = new ClientSocket();
    const refuse = vi.fn();
    relayContainerWebSocket({
      req: { method: 'GET', headers: {} } as IncomingMessage,
      socket: client as unknown as Socket, head: Buffer.alloc(0),
      upstream: { url: 'https://x', hostHeader: ENDPOINT, headers: { 'X-aws-proxy-auth': TOKEN, 'X-aws-proxy-port': '4000' } },
      upstreamPath: '/ws', forwardedHeaders: '', refuse, adoptUpstream: () => true, onResponded: vi.fn(),
      logError: () => {},
      connect: (_options, onConnect) => {
        if (options.answerConnect) queueMicrotask(onConnect);
        return upstream as unknown as Socket;
      },
    });
    return { upstream, client, refuse };
  }

  it('refuses with 502 when the endpoint never accepts the connection', async () => {
    const { upstream, refuse } = relay({ answerConnect: false });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(refuse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refuse).toHaveBeenCalledWith(502);
    expect(upstream.destroyed).toBe(true);
  });

  it('refuses with 502 when the endpoint accepts but never answers the upgrade', async () => {
    const { upstream, refuse } = relay({ answerConnect: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream.writes.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refuse).toHaveBeenCalledWith(502);
    expect(upstream.destroyed).toBe(true);
  });

  it('clears the deadline once the handshake has been relayed', async () => {
    const { upstream, client, refuse } = relay({ answerConnect: true });
    await vi.advanceTimersByTimeAsync(0);
    upstream.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refuse).not.toHaveBeenCalled();
    expect(upstream.destroyed).toBe(false);
    expect(client.writes.join('')).toContain('101 Switching Protocols');
  });
});
