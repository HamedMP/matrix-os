import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyUpstreamCredentials,
  closeUpstreamDispatchers,
  dispatcherForUpstream,
  stripUpstreamCredentials,
} from '../../packages/platform/src/substrates/upstream-transport.js';
import type { RuntimeUpstream } from '../../packages/platform/src/substrates/types.js';
import { generateSelfSignedCert } from './fake-hostd-server.js';
import { startFakeMetalIngress, type FakeMetalIngress } from './fake-metal-ingress.js';

/** ENG-520 Task P3: proxied requests to a host ingress verify TLS under the ingress name and route by the runtime Host. */

describe('upstream transport for host ingress upstreams', () => {
  const cert = generateSelfSignedCert();
  let ingress: FakeMetalIngress;
  let port: string;

  beforeAll(async () => {
    ingress = await startFakeMetalIngress(cert);
    port = ingress.ingressHost.split(':')[1]!;
  });
  afterAll(async () => {
    await closeUpstreamDispatchers();
    await ingress.close();
  });

  function upstream(overrides: Partial<RuntimeUpstream> = {}): RuntimeUpstream {
    return {
      url: `https://127.0.0.1:${port}/api/x`, hostHeader: 'alice.matrix-os.com', tlsServerName: 'fake-hostd.test',
      headers: { 'x-matrix-host-auth': 'ingress-token', 'x-matrix-vm-target': 'vm_0123456789abcdef01234567:3' },
      extraCaPem: cert.cert, ...overrides,
    };
  }

  async function send(target: RuntimeUpstream, clientHeaders: Record<string, string> = {}) {
    const headers = new Headers(clientHeaders);
    headers.set('host', target.hostHeader);
    applyUpstreamCredentials(headers, target);
    return fetch(target.url, { headers, dispatcher: dispatcherForUpstream(target, undefined as never) } as RequestInit);
  }

  it('verifies the certificate under the TLS server name while sending the runtime Host', async () => {
    const response = await send(upstream(), {
      'x-matrix-upstream-host': 'bob.matrix-os.com', 'x-matrix-host-auth': 'forged', 'x-matrix-vm-target': 'forged',
    });
    expect(response.status).toBe(200);
    const seen = ingress.requests.at(-1)!;
    expect(seen.headers.host).toBe('alice.matrix-os.com');
    expect(seen.headers['x-matrix-host-auth']).toBe('ingress-token');
    expect(seen.headers['x-matrix-vm-target']).toBe('vm_0123456789abcdef01234567:3');
    expect(seen.headers['x-matrix-upstream-host']).toBeUndefined();
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('x-matrix-vm-target', 'echoed');
    stripUpstreamCredentials(responseHeaders, upstream());
    expect(responseHeaders.has('x-matrix-host-auth')).toBe(false);
    expect(responseHeaders.has('x-matrix-vm-target')).toBe(false);
  });

  it('refuses an ingress whose certificate does not match the TLS server name', async () => {
    await expect(send(upstream({ tlsServerName: 'other-ingress.test' }))).rejects.toThrow();
  });

  it('refuses an ingress whose certificate is not signed by a trusted CA', async () => {
    const before = ingress.requests.length;
    await expect(send(upstream({ extraCaPem: generateSelfSignedCert().cert }))).rejects.toThrow();
    expect(ingress.requests.length).toBe(before);
  });

  it('keeps the caller dispatcher for plain VPS upstreams', () => {
    const vps = { url: 'https://203.0.113.5:443/', hostHeader: 'alice.matrix-os.com' };
    const sentinel = {} as never;
    expect(dispatcherForUpstream(vps, sentinel)).toBe(sentinel);
    const headers = new Headers({ 'x-matrix-host-auth': 'forged', 'x-matrix-upstream-host': 'bob.matrix-os.com', 'x-matrix-vm-target': 'forged' });
    applyUpstreamCredentials(headers, vps);
    expect([...headers.keys()]).toEqual([]);
  });
});
