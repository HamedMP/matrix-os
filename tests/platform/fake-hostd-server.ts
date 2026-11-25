import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A real local HTTPS server standing in for hostd. Its certificate is
 * self-signed for 127.0.0.1, so a client verifies it only when given the PEM
 * as an extra CA, the same way staging hosts are trusted.
 */

export interface FakeHostdRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type FakeHostdHandler = (req: FakeHostdRequest, res: ServerResponse) => void;

export interface FakeHostd {
  origin: string;
  caPem: string;
  requests: FakeHostdRequest[];
  handle(handler: FakeHostdHandler): void;
  close(): Promise<void>;
}

export function generateSelfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hostd-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2',
      '-subj', '/CN=fake-hostd', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:fake-hostd.test',
    ], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startFakeHostd(cert = generateSelfSignedCert()): Promise<FakeHostd> {
  let handler: FakeHostdHandler = (_req, res) => json(res, 404, { error: 'not_found' });
  const requests: FakeHostdRequest[] = [];
  const server: Server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `https://127.0.0.1:${port}`,
    caPem: cert.cert,
    requests,
    handle(next) {
      handler = next;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
