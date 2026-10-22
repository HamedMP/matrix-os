import { describe, expect, it, vi } from 'vitest';
import { createQualifiedFundedPlatformClient } from '../../packages/proxy/src/funded-qualified-platform-client.js';
import { qualifiedRouteFixture, qualifiedLeaseFixture } from '../helpers/google-qualified-funded-fixture.js';
const input = () => ({ protocol: 'matrix-google-qualified-funded-v1' as const, credential: `sk-matrix-google-funded-token_one.${'s'.repeat(43)}`,
  api: 'openai-completions' as const, canonicalModelId: qualifiedRouteFixture().canonicalModelId, expectedDigest: qualifiedRouteFixture().digest });
function reply() { const lease = qualifiedLeaseFixture(); const { token: _t, issuedAt: _at, ...tokenIdentity } = lease.credential;
  return { protocol: input().protocol, binding: { ...qualifiedRouteFixture(), requestClass: 'interactive' },
    authorization: { contractVersion: 1, authorized: true, identity: { ...lease.identity, ...tokenIdentity }, policy: lease.policy } }; }
const options = (fetch: typeof globalThis.fetch) => ({ fetch, platformBaseUrl: 'https://platform.example.test', relayControlToken: 'c'.repeat(32), platformTimeoutMs: 50, maxControlResponseBytes: 65536 });
describe('qualified relay service-control client bounds', () => {
  it('sends only exact qualified JSON to fixed control route with server authentication and content length', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(reply())); const client = createQualifiedFundedPlatformClient(options(fetch));
    expect(await client.check(input(), new AbortController().signal)).toEqual(reply()); const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://platform.example.test/internal/ai/funded/qualified/dispatch-check'); expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('content-length')).toBe(String(Buffer.byteLength(String(init?.body)))); expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(['oversize', 'chunks', 'invalid', 'error', 'stalled'])('rejects and cancels %s response with a generic error', async kind => {
    const cancel = vi.fn(); let chunk = 0; const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (kind === 'stalled') return new Promise(() => undefined);
      if (kind === 'oversize') controller.enqueue(new Uint8Array(65537));
      else if (kind === 'chunks') controller.enqueue(new Uint8Array([32]));
      else if (!chunk++) controller.enqueue(new TextEncoder().encode(kind === 'invalid' ? 'raw sensitive error' : JSON.stringify({ error: 'private provider failure' })));
      else controller.close();
    }, cancel });
    const client = createQualifiedFundedPlatformClient(options(async () => new Response(body, { status: kind === 'error' ? 500 : 200 })));
    await expect(client.check(input(), new AbortController().signal)).rejects.toThrow('Funded AI control-plane request failed'); expect(cancel).toHaveBeenCalledTimes(kind === 'invalid' || kind === 'error' ? 0 : 1);
  });
  it('logs only a fixed classification when cleanup fails',async()=>{
    const sensitive=Object.assign(new Error('private cleanup message'),{name:'PrivateCredentialValue'});
    const log=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const body=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(65537));},cancel(){throw sensitive;}});
    try{const client=createQualifiedFundedPlatformClient(options(async()=>new Response(body)));
      await expect(client.check(input(),new AbortController().signal)).rejects.toThrow();
      expect(log).toHaveBeenCalled();expect(JSON.stringify(log.mock.calls)).not.toContain('PrivateCredentialValue');
      expect(JSON.stringify(log.mock.calls)).not.toContain('private cleanup message');
    }finally{log.mockRestore();}
  });
  it('rejects parent abort while reading a stalled body and drains reader', async () => {
    const controller = new AbortController(), cancel = vi.fn(); const client = createQualifiedFundedPlatformClient(options(async () => {
      queueMicrotask(() => controller.abort()); return new Response(new ReadableStream({ pull: () => new Promise(() => undefined), cancel })); }));
    await expect(client.check(input(), controller.signal)).rejects.toThrow('Funded AI control-plane request failed'); expect(cancel).toHaveBeenCalled();
  });
});
