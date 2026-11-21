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
}

export interface FakeMetalIngress {
  /** `127.0.0.1:<port>`, the metal_hosts.ingress_host value. */
  ingressHost: string;
  requests: FakeIngressRequest[];
  close(): Promise<void>;
}

function record(req: IncomingMessage, upgrade: boolean): FakeIngressRequest {
  return { method: req.method ?? '', path: req.url ?? '', headers: req.headers, upgrade };
}

export async function startFakeMetalIngress(cert: { key: string; cert: string }): Promise<FakeMetalIngress> {
  const requests: FakeIngressRequest[] = [];
  const server: Server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    requests.push(record(req, false));
    req.resume();
    req.on('end', () => {
      // A misbehaving upstream that echoes the credential back must not leak it to clients.
      res.writeHead(200, { 'content-type': 'text/plain', 'x-matrix-host-auth': 'echoed-by-upstream' });
      res.end('runtime');
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    requests.push(record(req, true));
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
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
