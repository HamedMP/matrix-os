import type { IncomingMessage } from 'node:http';
import { isIP, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { PlatformDB, UserMachineRecord } from '../db.js';
import { rejectWebSocketUpgrade } from '../websocket-upgrade-rejection.js';
import { isSafeWebSocketUpgradePath, stripWebSocketUpgradeToken } from '../ws-upgrade.js';
import type { SubstrateRegistry } from './registry.js';
import { decideOnDemandWake, noteOwnerReachedRuntime, wakeRefusal, type WakeIdentity } from './substrate-wake.js';
import type { RuntimeUpstream } from './types.js';
import { isRuntimeAsleepBody, RUNTIME_ASLEEP_ERROR, wakeAfterAsleep } from './runtime-asleep.js';
import { INGRESS_ERROR_HEADER, isCredentialHeaderLine, trustedCaList } from './upstream-transport.js';

/**
 * WebSocket upgrades to on-demand runtimes (spec 2691, ENG-520 Task P3).
 * Adapted from feat/2691-container-register `container-websocket.ts`: the
 * owner's upgrade waits for the shared wake, then the platform dials the
 * substrate upstream over verified TLS (system roots plus the upstream's
 * extra CA, under its TLS server name), sends the upstream's credential
 * headers, and strips any credential line from the handshake answer.
 */

const MAX_HANDSHAKE_BYTES = 16 * 1024;
/** Bounds the TLS connect plus the wait for the upstream handshake head. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_ASLEEP_BODY_BYTES = 4 * 1024;

export interface OnDemandWebSocketUpgrade {
  db: PlatformDB;
  substrates: SubstrateRegistry | undefined;
  machine: UserMachineRecord;
  identity: WakeIdentity;
  req: IncomingMessage;
  socket: Socket;
  head: Buffer;
  /** Upstream path with query, including any upgrade token (stripped before forwarding). */
  proxyPath: string;
  /** Header lines from the shared builder, without Host. */
  buildForwardedHeaders(machine: UserMachineRecord): string;
  refuse(status: 400 | 502 | 503): void;
  adoptUpstream(upstream: Socket): boolean;
  onResponded(): void;
  /** Test seam: defaults to verified TLS. */
  connect?: typeof connectTls;
}

function withoutLines(headers: string, upstream: RuntimeUpstream): string {
  return headers.split('\r\n').filter((line) => {
    const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
    return line.length > 0 && name !== 'host' && !isCredentialHeaderLine(line, upstream);
  }).join('\r\n');
}

function sanitizeHandshake(head: string, upstream: RuntimeUpstream): string {
  const [statusLine, ...lines] = head.split('\r\n');
  return [statusLine, ...lines.filter((line) => !isCredentialHeaderLine(line, upstream))].join('\r\n');
}

/** A 503 the client can classify: Retry-After plus the same JSON body HTTP callers get. */
function refuseWithWakeBody(socket: Socket, refusal: ReturnType<typeof wakeRefusal>): void {
  rejectWebSocketUpgrade(socket, 503, {
    ...(refusal.retryAfter ? { retryAfter: refusal.retryAfter } : {}),
    jsonBody: JSON.stringify(refusal.body),
  });
}

/** Wakes the runtime for its owner when needed, then relays the upgrade to the substrate upstream. */
export async function proxyOnDemandWebSocket(upgrade: OnDemandWebSocketUpgrade): Promise<void> {
  const { substrates, socket } = upgrade;
  if (!substrates) {
    upgrade.refuse(503);
    return;
  }
  const decision = await decideOnDemandWake({
    db: upgrade.db, substrates, machine: upgrade.machine, identity: upgrade.identity,
  });
  if (socket.destroyed) return;
  if (decision.kind !== 'proceed') {
    refuseWithWakeBody(socket, wakeRefusal(decision));
    return;
  }
  if (!isSafeWebSocketUpgradePath(upgrade.proxyPath)) {
    upgrade.refuse(400);
    return;
  }
  const machine = decision.machine;
  const resolution = substrates.resolveUpstream(machine, { path: '/' });
  if (resolution.kind !== 'upstream') {
    upgrade.refuse(503);
    return;
  }
  relay(upgrade, machine, resolution.upstream, () => {
    retryAfterAsleep(upgrade, substrates, machine).catch((error: unknown) => {
      console.warn('[on-demand-websocket] wake after asleep failed', error instanceof Error ? error.name : 'unknown');
      upgrade.refuse(503);
    });
  });
}

/**
 * The ingress answered `runtime_asleep` before forwarding the upgrade: record
 * the VM asleep, wake it once, and dial once more. Nothing has been written to
 * the client yet, so it still gets a plain HTTP answer if the VM stays asleep.
 */
async function retryAfterAsleep(upgrade: OnDemandWebSocketUpgrade, substrates: SubstrateRegistry, machine: UserMachineRecord): Promise<void> {
  const decision = await wakeAfterAsleep({ db: upgrade.db, substrates, machine, identity: upgrade.identity });
  if (upgrade.socket.destroyed) return;
  if (decision.kind !== 'proceed') {
    refuseWithWakeBody(upgrade.socket, wakeRefusal(decision));
    return;
  }
  const resolution = substrates.resolveUpstream(decision.machine, { path: '/' });
  if (resolution.kind !== 'upstream') {
    upgrade.refuse(503);
    return;
  }
  relay(upgrade, decision.machine, resolution.upstream,
    () => refuseWithWakeBody(upgrade.socket, wakeRefusal({ kind: 'not_ready', state: 'waking' })));
}

/** A small 503 whose JSON body says `runtime_asleep`; anything else is relayed as before. */
function readAsleepAnswer(buffered: Buffer, end: number): 'asleep' | 'other' | 'incomplete' {
  const head = buffered.subarray(0, end).toString('latin1');
  if (!/^HTTP\/1\.[01] 503 /.test(head)) return 'other';
  const marked = head.split('\r\n').slice(1).some((line) => {
    const colon = line.indexOf(':');
    return colon > 0 && line.slice(0, colon).trim().toLowerCase() === INGRESS_ERROR_HEADER
      && line.slice(colon + 1).trim() === RUNTIME_ASLEEP_ERROR;
  });
  if (!marked) return 'other';
  const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? Number.NaN);
  if (!Number.isSafeInteger(length) || length > MAX_ASLEEP_BODY_BYTES) return 'other';
  if (buffered.length < end + 4 + length) return 'incomplete';
  return isRuntimeAsleepBody(buffered.subarray(end + 4, end + 4 + length).toString('utf8')) ? 'asleep' : 'other';
}

function relay(upgrade: OnDemandWebSocketUpgrade, machine: UserMachineRecord, upstream: RuntimeUpstream, onAsleep: () => void): void {
  const { req, socket } = upgrade;
  const target = new URL(upstream.url);
  const port = Number(target.port || 443);
  const ca = trustedCaList(upstream);
  const serverName = upstream.tlsServerName ?? target.hostname;
  const forwarded = withoutLines(upgrade.buildForwardedHeaders(machine), upstream);
  const credentials = Object.entries(upstream.headers ?? {}).map(([name, value]) => `${name}: ${value}`);
  const connect = upgrade.connect ?? connectTls;
  let settled = false;
  let handedOff = false;
  const fail = (status: 502, cause: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    console.warn('[on-demand-websocket] upstream failed', JSON.stringify({ machineId: machine.machineId, cause }));
    connection.destroy();
    upgrade.refuse(status);
  };
  const deadline = setTimeout(() => fail(502, 'timeout'), HANDSHAKE_TIMEOUT_MS);
  deadline.unref?.();
  const connection = connect({
    host: target.hostname,
    port,
    // An IP server name is not valid SNI; Node then verifies the certificate against the address.
    ...(isIP(serverName) ? {} : { servername: serverName }),
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
  }, () => {
    if (settled) return;
    if (!upgrade.adoptUpstream(connection)) {
      settled = true;
      clearTimeout(deadline);
      return;
    }
    const path = stripWebSocketUpgradeToken(upgrade.proxyPath);
    const lines = [`${req.method ?? 'GET'} ${path} HTTP/1.1`, `Host: ${upstream.hostHeader}`,
      ...(forwarded ? [forwarded] : []), ...credentials];
    connection.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upgrade.head.length > 0) connection.write(upgrade.head);
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0 ? buffered.length > MAX_HANDSHAKE_BYTES : end > MAX_HANDSHAKE_BYTES) {
        fail(502, 'handshake_too_large');
        return;
      }
      if (end < 0) return;
      const asleep = readAsleepAnswer(buffered, end);
      if (asleep === 'incomplete') return;
      connection.off('data', onData);
      if (asleep === 'asleep') {
        settled = true;
        handedOff = true;
        clearTimeout(deadline);
        connection.destroy();
        onAsleep();
        return;
      }
      settled = true;
      clearTimeout(deadline);
      upgrade.onResponded();
      const answer = sanitizeHandshake(buffered.subarray(0, end).toString('latin1'), upstream);
      socket.write(`${answer}\r\n\r\n`, 'latin1');
      if (answer.startsWith('HTTP/1.1 101')) noteOwnerReachedRuntime(upgrade.db, machine, upgrade.identity, 101);
      const rest = buffered.subarray(end + 4);
      if (rest.length > 0) socket.write(rest);
      connection.pipe(socket);
      socket.pipe(connection);
    };
    connection.on('data', onData);
    connection.on('close', () => {
      if (handedOff) return;
      if (!settled) fail(502, 'closed');
      else upgrade.refuse(502);
    });
  });
  connection.on('error', (error: Error) => fail(502, error.name));
}
