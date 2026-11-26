import { createServer, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer } from 'ws';

/**
 * A real local HTTPS server standing in for a metal host's ingress
 * (ENG-520). It answers HTTP requests and echoes WebSocket messages, and it
 * records what the platform sent so tests can check the Host header, the
 * host-auth credential, and the path. Its certificate is self-signed for
 * 127.0.0.1, so the platform reaches it only when it trusts the extra CA.
 */

export interface FakeIngressRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  upgrade: boolean;
  body: string;
}

export interface FakeMetalIngress {
  /** `127.0.0.1:<port>`, the metal_hosts.ingress_host value. */
  ingressHost: string;
  requests: FakeIngressRequest[];
  /** The next N requests or upgrades answer 503 runtime_asleep, as the real ingress does for a suspended VM. */
  asleepResponses: number;
  /** The next N requests reach the VM, whose app answers a 503 runtime_asleep body without the ingress marker. */
  vmAsleepBodyResponses: number;
  /** The next N upgrades answer the marked runtime_asleep 503 with a chunked body (no Content-Length). */
  chunkedAsleepUpgrades: number;
  /** Optional VM answer for a forwarded request; return undefined for the default text answer. */
  respond?: (request: FakeIngressRequest) => { status: number; body: unknown } | undefined;
  close(): Promise<void>;
}

const ASLEEP_BODY = JSON.stringify({ error: 'runtime_asleep' });

function record(req: IncomingMessage, upgrade: boolean): FakeIngressRequest {
  return { method: req.method ?? '', path: req.url ?? '', headers: req.headers, upgrade, body: '' };
}

export async function startFakeMetalIngress(cert: { key: string; cert: string }): Promise<FakeMetalIngress> {
  const requests: FakeIngressRequest[] = [];
  const state: { asleepResponses: number; vmAsleepBodyResponses: number; chunkedAsleepUpgrades: number; respond?: FakeMetalIngress['respond'] } = {
    asleepResponses: 0, vmAsleepBodyResponses: 0, chunkedAsleepUpgrades: 0,
  };
  const server: Server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const recorded = record(req, false);
    requests.push(recorded);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      recorded.body = Buffer.concat(chunks).toString('utf8');
      if (state.asleepResponses > 0) {
        state.asleepResponses -= 1;
        // The ingress marks its own answer so it cannot be confused with a VM response.
        res.writeHead(503, { 'content-type': 'application/json', 'x-matrix-ingress-error': 'runtime_asleep' });
        res.end(ASLEEP_BODY);
        return;
      }
      if (state.vmAsleepBodyResponses > 0) {
        state.vmAsleepBodyResponses -= 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(ASLEEP_BODY);
        return;
      }
      const answer = state.respond?.(recorded);
      if (answer) {
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
        return;
      }
      // A misbehaving upstream that echoes the credential back must not leak it to clients.
      res.writeHead(200, { 'content-type': 'text/plain', 'x-matrix-host-auth': 'echoed-by-upstream' });
      res.end('runtime');
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    requests.push(record(req, true));
    if (state.chunkedAsleepUpgrades > 0) {
      state.chunkedAsleepUpgrades -= 1;
      const size = Buffer.byteLength(ASLEEP_BODY).toString(16);
      socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nx-matrix-ingress-error: runtime_asleep\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${size}\r\n${ASLEEP_BODY}\r\n0\r\n\r\n`);
      return;
    }
    if (state.asleepResponses > 0) {
      state.asleepResponses -= 1;
      socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nx-matrix-ingress-error: runtime_asleep\r\nContent-Length: ${ASLEEP_BODY.length}\r\nConnection: close\r\n\r\n${ASLEEP_BODY}`);
      return;
    }
    if (state.vmAsleepBodyResponses > 0) {
      state.vmAsleepBodyResponses -= 1;
      socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ${ASLEEP_BODY.length}\r\nConnection: close\r\n\r\n${ASLEEP_BODY}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
    });
  });
  // Upstream handshakes may carry headers; echo the credential name to prove it is stripped.
  wss.on('headers', (headers) => { headers.push('x-matrix-host-auth: echoed-by-upstream'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ingressHost: `127.0.0.1:${port}`,
    requests,
    get asleepResponses() { return state.asleepResponses; },
    set asleepResponses(value: number) { state.asleepResponses = value; },
    get vmAsleepBodyResponses() { return state.vmAsleepBodyResponses; },
    set vmAsleepBodyResponses(value: number) { state.vmAsleepBodyResponses = value; },
    get chunkedAsleepUpgrades() { return state.chunkedAsleepUpgrades; },
    set chunkedAsleepUpgrades(value: number) { state.chunkedAsleepUpgrades = value; },
    get respond() { return state.respond; },
    set respond(value: FakeMetalIngress['respond']) { state.respond = value; },
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
