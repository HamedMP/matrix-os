import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { COMPUTE_MODE_HEADER, type ComputeMode, type RuntimeState } from '@matrix-os/contracts';
import { getUserMachine } from '../database/user-machines.js';
import type { PlatformDB, UserMachineRecord } from '../db.js';
import type { SubstrateRegistry } from './registry.js';
import type { EnsureRunningResult, RuntimeUpstream } from './types.js';
import { nextMonthStartUtc } from '../free-tier/compute-meter.js';
import { isExportIntent, isExportOnlyRequest, type ExportRequestLike } from './container-export-only.js';

/**
 * WebSocket proxying to a container runtime. The provider endpoint
 * authenticates WebSockets through subprotocols rather than headers (spike
 * S1): `lambda-microvms`, `lambda-microvms.authentication.<token>`, and
 * `lambda-microvms.port.<port>`. The platform adds them to the client's own
 * subprotocols and removes every `lambda-microvms` entry from the upstream's
 * handshake answer, so the token never reaches the client.
 */

const ENSURE_RUNNING_TIMEOUT_MS = 15_000;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
/** Bounds the TLS connect plus the wait for the upstream handshake head. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const PROVIDER_PROTOCOL = 'lambda-microvms';
const AUTH_HEADER = 'x-aws-proxy-auth';
const PORT_HEADER = 'x-aws-proxy-port';

export type ContainerWakeDecision =
  | { kind: 'proceed'; machine: UserMachineRecord }
  | { kind: 'not_ready'; state: Extract<RuntimeState, 'waking' | 'busy' | 'failed'>; result: EnsureRunningResult }
  | { kind: 'limit_reached'; resetsAt: string; retryAfterSeconds: number }
  | { kind: 'unavailable' };

/** An export-only unit serves only export and read requests; a WebSocket (no request given) never qualifies. */
function exportOnlyGate(machine: UserMachineRecord, request: ExportRequestLike | undefined, at: Date): ContainerWakeDecision | null {
  if (machine.computeMode !== 'export_only' || (request && isExportOnlyRequest(request))) return null;
  const resetsAt = nextMonthStartUtc(machine.startedAt ? new Date(machine.startedAt) : at);
  // The month turned while this unit runs; it stops within its export window and then wakes normally.
  if (resetsAt.getTime() <= at.getTime()) return { kind: 'not_ready', state: 'busy', result: { state: 'busy' } };
  return limitReached(resetsAt.toISOString(), at);
}

function limitReached(resetsAt: string, at: Date): ContainerWakeDecision {
  const seconds = Math.ceil((Date.parse(resetsAt) - at.getTime()) / 1_000);
  return { kind: 'limit_reached', resetsAt, retryAfterSeconds: Number.isFinite(seconds) ? Math.max(1, seconds) : 1 };
}

/** The mode the gateway on a container unit runs in; only the platform sets it. */
export function computeModeOf(machine: UserMachineRecord): ComputeMode {
  return machine.computeMode === 'export_only' ? 'export_only' : 'full';
}

/**
 * Owner requests may start compute; any other caller reaches the runtime only
 * while it is already routable. VPS machines and an unconfigured container
 * substrate pass through unchanged.
 */
export async function decideContainerWake(input: {
  db: PlatformDB;
  substrates: SubstrateRegistry;
  machine: UserMachineRecord;
  identity: { userId: string; source?: string };
  /** The upstream request, for export intent and the export-only gate; absent for WebSocket upgrades. */
  request?: ExportRequestLike;
  logError?: (message: string, detail: Record<string, string>) => void;
}): Promise<ContainerWakeDecision> {
  const { machine, identity, request } = input;
  if (machine.substrate !== 'container') return { kind: 'proceed', machine };
  const lookup = input.substrates.get('container');
  if (!lookup.ok) return { kind: 'proceed', machine };
  const now = () => lookup.substrate.now?.() ?? new Date();
  const owner = identity.source === 'auth' && Boolean(identity.userId) && identity.userId === machine.clerkUserId;
  if (!owner) {
    if (machine.computeMode === 'export_only') return { kind: 'unavailable' };
    if (input.substrates.resolveUpstream(machine, { path: '/' }).kind === 'upstream') return { kind: 'proceed', machine };
    try {
      const routable = await lookup.substrate.ensureRoutable?.({
        machineId: machine.machineId, handle: machine.handle, runtimeSlot: machine.runtimeSlot, generation: machine.generation,
      }, AbortSignal.timeout(ENSURE_RUNNING_TIMEOUT_MS)) ?? false;
      return routable ? { kind: 'proceed', machine } : { kind: 'unavailable' };
    } catch (error: unknown) {
      (input.logError ?? ((message, detail) => console.error(message, detail)))(
        '[container-wake] ensure routable failed', { cause: error instanceof Error ? error.name : 'unknown' });
      return { kind: 'unavailable' };
    }
  }
  let result: EnsureRunningResult;
  try {
    result = await lookup.substrate.ensureRunning({
      machineId: machine.machineId, handle: machine.handle, runtimeSlot: machine.runtimeSlot, generation: machine.generation,
    }, AbortSignal.timeout(ENSURE_RUNNING_TIMEOUT_MS), { exportIntent: request ? isExportIntent(request) : false });
  } catch (error: unknown) {
    (input.logError ?? ((message, detail) => console.error(message, detail)))(
      '[container-wake] ensure running failed', { cause: error instanceof Error ? error.name : 'unknown' });
    result = { state: 'failed', code: 'provider_unavailable' };
  }
  if (result.state === 'starting') return { kind: 'not_ready', state: 'waking', result };
  if (result.state === 'busy') return { kind: 'not_ready', state: 'busy', result };
  if (result.state === 'failed') return { kind: 'not_ready', state: 'failed', result };
  if (result.state === 'limit_reached') return limitReached(result.resetsAt, now());
  const current = await getUserMachine(input.db, machine.machineId);
  if (!current || current.deletedAt) {
    return { kind: 'not_ready', state: 'failed', result: { state: 'failed', code: 'needs_recovery' } };
  }
  return exportOnlyGate(current, request, now()) ?? { kind: 'proceed', machine: current };
}

function isProviderProtocol(value: string): boolean {
  return value === PROVIDER_PROTOCOL || value.startsWith(`${PROVIDER_PROTOCOL}.`);
}

function splitProtocols(value: string | string[] | undefined): string[] {
  const joined = Array.isArray(value) ? value.join(',') : value ?? '';
  return joined.split(',').map((item) => item.trim()).filter(Boolean);
}

/** The client's own subprotocols, with any provider-looking entry a client tried to inject removed. */
export function clientSubprotocols(value: string | string[] | undefined): string[] {
  return splitProtocols(value).filter((protocol) => !isProviderProtocol(protocol));
}

/** Provider authentication first, then the client's own protocols in their original order. */
export function buildContainerSubprotocols(upstream: RuntimeUpstream, clientValue: string | string[] | undefined): string | null {
  const headers = Object.fromEntries(Object.entries(upstream.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const token = headers[AUTH_HEADER];
  const port = headers[PORT_HEADER];
  if (!token || !port || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(token) || !/^\d{1,5}$/.test(port)) return null;
  return [PROVIDER_PROTOCOL, `${PROVIDER_PROTOCOL}.authentication.${token}`, `${PROVIDER_PROTOCOL}.port.${port}`,
    ...clientSubprotocols(clientValue)].join(', ');
}

/**
 * Rewrites the upstream handshake head: provider subprotocols are dropped from
 * `Sec-WebSocket-Protocol`, the header goes away if nothing of the client's is
 * left, and any line carrying the token is removed outright.
 */
export function sanitizeUpstreamHandshake(head: string, token: string): string {
  const [statusLine, ...lines] = head.split('\r\n');
  const kept: string[] = [];
  for (const line of lines) {
    const match = /^sec-websocket-protocol\s*:(.*)$/i.exec(line);
    if (match) {
      const remaining = splitProtocols(match[1]).filter((protocol) => !isProviderProtocol(protocol) && !(token && protocol.includes(token)));
      if (remaining.length > 0) kept.push(`Sec-WebSocket-Protocol: ${remaining.join(', ')}`);
    } else if (!token || !line.includes(token)) {
      kept.push(line);
    }
  }
  return [statusLine, ...kept].join('\r\n');
}

export interface ContainerWebSocketRelay {
  req: IncomingMessage;
  socket: Socket;
  head: Buffer;
  upstream: RuntimeUpstream;
  upstreamPath: string;
  /** Header lines from the shared builder, without the client's subprotocol header. */
  forwardedHeaders: string;
  /** From the machine row; any client line of the same name is dropped first. */
  computeMode: ComputeMode;
  refuse(status: 502 | 503): void;
  adoptUpstream(upstream: Socket): boolean;
  onResponded(): void;
  logError?: (message: string, detail: Record<string, string>) => void;
  /** Test seam: defaults to verified TLS to the endpoint host. */
  connect?: (options: { host: string; port: number; servername: string }, onConnect: () => void) => Socket;
}

function withoutLines(headers: string, names: readonly string[]): string {
  return headers.split('\r\n').filter((line) => {
    const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
    return line.length > 0 && !names.includes(name);
  }).join('\r\n');
}

/** Dials the endpoint, writes the authenticated upgrade, and relays bytes once the head is sanitized. */
export function relayContainerWebSocket(relay: ContainerWebSocketRelay): void {
  const logError = relay.logError ?? ((message, detail) => console.warn(message, detail));
  const protocols = buildContainerSubprotocols(relay.upstream, relay.req.headers['sec-websocket-protocol']);
  const token = Object.entries(relay.upstream.headers ?? {}).find(([key]) => key.toLowerCase() === AUTH_HEADER)?.[1] ?? '';
  if (!protocols || !token) {
    relay.refuse(503);
    return;
  }
  const host = relay.upstream.hostHeader;
  const connect = relay.connect ?? ((options, onConnect) => connectTls({ ...options, rejectUnauthorized: true }, onConnect));
  const headers = withoutLines(relay.forwardedHeaders, ['sec-websocket-protocol', AUTH_HEADER, PORT_HEADER, 'host', COMPUTE_MODE_HEADER]);
  let settled = false;
  const deadline = setTimeout(() => {
    if (settled) return;
    settled = true;
    logError('[container-websocket] upstream handshake timed out', { cause: 'timeout' });
    upstream.destroy();
    relay.refuse(502);
  }, HANDSHAKE_TIMEOUT_MS);
  deadline.unref?.();
  const upstream = connect({ host, port: 443, servername: relay.upstream.tlsServerName ?? host }, () => {
    if (settled) return;
    if (!relay.adoptUpstream(upstream)) {
      settled = true;
      clearTimeout(deadline);
      return;
    }
    const lines = [`${relay.req.method ?? 'GET'} ${relay.upstreamPath} HTTP/1.1`, `Host: ${host}`,
      ...(headers ? [headers] : []), `${COMPUTE_MODE_HEADER}: ${relay.computeMode}`, `Sec-WebSocket-Protocol: ${protocols}`];
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (relay.head.length > 0) upstream.write(relay.head);
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      // The header is bounded whether or not this chunk also carries its terminator.
      if (end < 0 ? buffered.length > MAX_HANDSHAKE_BYTES : end > MAX_HANDSHAKE_BYTES) {
        settled = true;
        clearTimeout(deadline);
        upstream.destroy();
        relay.refuse(502);
        return;
      }
      if (end < 0) return;
      upstream.off('data', onData);
      settled = true;
      clearTimeout(deadline);
      relay.onResponded();
      relay.socket.write(`${sanitizeUpstreamHandshake(buffered.subarray(0, end).toString('latin1'), token)}\r\n\r\n`, 'latin1');
      const rest = buffered.subarray(end + 4);
      if (rest.length > 0) relay.socket.write(rest);
      upstream.pipe(relay.socket);
      relay.socket.pipe(upstream);
    };
    upstream.on('data', onData);
    upstream.on('close', () => { settled = true; clearTimeout(deadline); relay.refuse(502); });
  });
  upstream.on('error', (err: Error) => {
    settled = true;
    clearTimeout(deadline);
    upstream.destroy();
    logError('[container-websocket] upstream failed', { cause: err.name });
    relay.refuse(502);
  });
}
