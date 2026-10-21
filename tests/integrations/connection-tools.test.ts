import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectServiceHandler, getGmailConnectionOptionsHandler, type GatewayFetcher } from '../../packages/kernel/src/tools/integrations.js';
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('agent Gmail connection method parity', () => {
  it.each(['matrix', 'pipedream'] as const)('forwards explicit %s consent with the exact label and owner authorization', async connectionMethod => {
    vi.stubEnv('MATRIX_AUTH_TOKEN', 'runtime-token'); vi.stubEnv('MATRIX_CLERK_USER_ID', 'user_owner'); vi.stubEnv('MATRIX_AGENT_INTEGRATIONS_TOKEN', undefined);
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(response({ url: 'https://app.matrix-os.com/auth/gmail?state=opaque', service: 'gmail' }));
    await connectServiceHandler({ service: 'gmail', label: 'Work Gmail', connectionMethod }, fetcher);
    expect(fetcher).toHaveBeenCalledWith('http://localhost:4000/api/integrations/connect', expect.objectContaining({
      body: JSON.stringify({ service: 'gmail', label: 'Work Gmail', connectionMethod }), headers: expect.objectContaining({ Authorization: 'Bearer runtime-token', 'x-platform-user-id': 'user_owner' }), signal: expect.any(AbortSignal) }));
  });
  it('preserves omitted method and refuses invalid/non-Gmail methods before dispatch', async () => {
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(response({ url: 'https://connect.test', service: 'github' }));
    await connectServiceHandler({ service: 'github' }, fetcher); expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ service: 'github' }); fetcher.mockClear();
    for (const input of [{ service: 'github', connectionMethod: 'matrix' }, { service: 'gmail', connectionMethod: 'unknown' }]) {
      expect((await connectServiceHandler(input as any, fetcher)).isError).toBe(true);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ methods: ['matrix', 'pipedream'], defaultMethod: 'matrix' }, { methods: ['pipedream'], defaultMethod: 'pipedream' }])('discovers bounded server capabilities for the authenticated owner', async options => {
    vi.stubEnv('MATRIX_AUTH_TOKEN', 'runtime-token'); vi.stubEnv('MATRIX_AGENT_INTEGRATIONS_TOKEN', undefined);
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(response(options));
    const result = await getGmailConnectionOptionsHandler(fetcher);
    expect(JSON.parse(result.content[0].text)).toEqual(options);
    expect(fetcher).toHaveBeenCalledWith('http://localhost:4000/api/integrations/gmail/connection-options', expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: 'Bearer runtime-token' }) }));
  });
  it('treats only missing discovery as legacy and hides provider errors/invalid capabilities', async () => {
    expect(JSON.parse((await getGmailConnectionOptionsHandler(vi.fn<GatewayFetcher>().mockResolvedValue(response({}, 404)))).content[0].text)).toEqual({ methods: ['pipedream'], defaultMethod: 'pipedream' });
    for (const [body, status] of [[{ error: 'private-provider-secret' }, 500], [{ methods: ['matrix', 'matrix'], defaultMethod: 'matrix' }, 200], [{ private: 'x'.repeat(5000) }, 200]] as const) {
      const result = await getGmailConnectionOptionsHandler(vi.fn<GatewayFetcher>().mockResolvedValue(response(body, status)));
      expect(result.isError).toBe(true); expect(result.content[0].text).not.toMatch(/private|x{100}/);
    }
  });
  it.each([404, 503])('cancels unread error metadata bodies for status %s', async status => {
    const cancel = vi.fn();
    const fetcher = vi.fn<GatewayFetcher>().mockImplementation(async () => new Response(new ReadableStream({ cancel }), { status }));
    await getGmailConnectionOptionsHandler(fetcher);
    expect(cancel).toHaveBeenCalledOnce();
    cancel.mockClear();
    await connectServiceHandler({ service: 'gmail' }, fetcher);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('bounds a stalled metadata stream through the read deadline', async () => {
    vi.useFakeTimers(); let cancelled = false;
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    const result = getGmailConnectionOptionsHandler(fetcher);
    await vi.advanceTimersByTimeAsync(10001);
    expect((await result).isError).toBe(true); expect(cancelled).toBe(true);
  });
});
