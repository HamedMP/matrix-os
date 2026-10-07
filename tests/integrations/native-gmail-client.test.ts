import { describe, expect, it, vi } from 'vitest';
import { createNativeGmailClient } from '../../packages/gateway/src/integrations/native-gmail/client.js';
import type { PipedreamConnectClient } from '../../packages/gateway/src/integrations/pipedream.js';
const accountId = 'gmail_11111111-1111-4111-8111-111111111111';
const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
function setup(response: () => Promise<Response> = async () => Response.json({ id: 'message' })) {
  const legacy = { proxyGet: vi.fn(async () => ({ legacy: true })), proxyPost: vi.fn() } as unknown as PipedreamConnectClient;
  const token = vi.fn(async () => 'secret');
  const fetcher = vi.fn(response);
  const client = createNativeGmailClient({ legacy, oauth: { token }, fetcher });
  return { client, fetcher, token, legacy };
}
describe('native Gmail transport', () => {
  it('routes an exact native account directly without paid proxy calls', async () => {
    const s = setup();
    expect(await s.client.proxyGet({ externalUserId: 'owner', accountId, url: `${base}/messages/abc` })).toEqual({ id: 'message' });
    expect(s.legacy.proxyGet).not.toHaveBeenCalled();
    expect(s.token).toHaveBeenCalledWith({ externalUserId: 'owner', accountId }, expect.any(AbortSignal));
    expect(s.fetcher).toHaveBeenCalledWith(`${base}/messages/abc`, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: 'Bearer secret' }) }));
  });
  it('preserves legacy accounts', async () => {
    const s = setup();
    expect(await s.client.proxyGet({ externalUserId: 'owner', accountId: 'ap_old', url: `${base}/profile` })).toEqual({ legacy: true });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each(['https://evil.example/path', `${base}/messages/../profile`, `${base}/messages/%2e%2e/profile`, `${base}/messages/abc/trash`, `${base}/messages/abc?access_token=evil`])('rejects unsafe target %s before token resolution', async url => {
    const s = setup();
    await expect(s.client.proxyGet({ externalUserId: 'owner', accountId, url })).rejects.toThrow('Gmail request unavailable');
    expect(s.token).not.toHaveBeenCalled();
  });
  it('fails closed for malformed native IDs and injected auth headers', async () => {
    const s = setup();
    await expect(s.client.proxyGet({ externalUserId: 'owner', accountId: 'gmail_bad', url: `${base}/profile` })).rejects.toThrow();
    await expect(s.client.proxyGet({ externalUserId: 'owner', accountId, url: `${base}/profile`, headers: { Authorization: 'other' } })).rejects.toThrow();
    expect(s.legacy.proxyGet).not.toHaveBeenCalled();
    expect(s.token).not.toHaveBeenCalled();
  });
  it('does not fetch when exact owner authorization fails', async () => {
    const s = setup(); s.token.mockRejectedValue(new Error('denied'));
    await expect(s.client.proxyGet({ externalUserId: 'other-owner', accountId, url: `${base}/profile` })).rejects.toThrow();
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('coalesces only concurrent identical reads; completed reads are fresh', async () => {
    let finish!: (r: Response) => void;
    const s = setup(() => new Promise(r => { finish = r; }));
    const input = { externalUserId: 'owner', accountId, url: `${base}/profile` };
    const first = s.client.proxyGet(input); const second = s.client.proxyGet(input);
    await vi.waitFor(() => expect(s.fetcher).toHaveBeenCalledTimes(1));
    finish(Response.json({ emailAddress: 'owner@example.com' })); await Promise.all([first, second]);
    s.fetcher.mockImplementation(async () => Response.json({ changed: true }));
    expect(await s.client.proxyGet(input)).toEqual({ changed: true });
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
  it('never retries writes and returns coarse provider status', async () => {
    const s = setup(async () => new Response('private details', { status: 429 }));
    await expect(s.client.proxyPost({ externalUserId: 'owner', accountId, url: `${base}/messages/send`, body: { raw: 'encoded' } })).rejects.toMatchObject({ statusCode: 429, message: 'Gmail request unavailable' });
    expect(s.fetcher).toHaveBeenCalledTimes(1); expect(s.legacy.proxyPost).not.toHaveBeenCalled();
  });
  it('bounds streaming replies without Content-Length', async () => {
    const s = setup(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); c.close(); } })));
    await expect(s.client.proxyGet({ externalUserId: 'owner', accountId, url: `${base}/messages/abc` })).rejects.toThrow();
  });
  it('preserves complete bounded attachments and rejects dishonest/truncated data', async () => {
    const data = Buffer.from([0, 1, 255, 42]).toString('base64url');
    const s = setup(async () => Response.json({ size: 4, data }));
    const input = { externalUserId: 'owner', accountId, url: `${base}/messages/abc/attachments/def` };
    expect(await s.client.proxyGet(input)).toEqual({ size: 4, data });
    s.fetcher.mockImplementation(async () => Response.json({ size: 5, data }));
    await expect(s.client.proxyGet(input)).rejects.toThrow();
    s.fetcher.mockImplementation(async () => Response.json({ size: 2 * 1024 * 1024, data: 'YQ' }));
    await expect(s.client.proxyGet(input)).rejects.toThrow();
  });
  it.each([1, 1024 * 1024])('accepts complete canonical padded base64url for %i bytes', async size => {
    const bytes = Buffer.alloc(size, 255);
    const unpadded = bytes.toString('base64url');
    const data = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
    const s = setup(async () => Response.json({ size, data }));
    const result = await s.client.proxyGet({ externalUserId: 'owner', accountId, url: `${base}/messages/abc/attachments/def` });
    expect(result).toEqual({ size, data });
    expect(Buffer.from((result as { data: string }).data, 'base64url')).toEqual(bytes);
  });
  it.each(['YQ=', 'YQ===', 'YR=='])('rejects malformed attachment padding or noncanonical bits %s', async data => {
    const s = setup(async () => Response.json({ size: 1, data }));
    await expect(s.client.proxyGet({ externalUserId: 'owner', accountId, url: `${base}/messages/abc/attachments/def` })).rejects.toThrow();
  });
  it('keeps narrow recipe reads bounded', async () => {
    const s = setup(async () => Response.json({ threads: [] }));
    await s.client.boundedGmailGet!({ kind: 'threads', externalUserId: 'owner', accountId });
    const url = new URL(s.fetcher.mock.calls[0]![0] as unknown as string);
    expect(url.origin).toBe('https://gmail.googleapis.com'); expect(url.searchParams.get('maxResults')).toBe('30');
    expect(url.searchParams.get('labelIds')).toBe('INBOX');
    await expect(s.client.boundedGmailGet!({ kind: 'message', externalUserId: 'owner', accountId, id: '../bad' })).rejects.toThrow();
  });
  it('keeps history IDs as strings', async () => {
    const s = setup(async () => Response.json({ historyId: '9007199254740993' }));
    await s.client.proxyGet({ externalUserId: 'owner', accountId, url: `${base}/history`, params: { startHistoryId: '9007199254740993', maxResults: '50' } });
    expect(String(s.fetcher.mock.calls[0]![0])).toContain('9007199254740993');
  });
});

describe('native Gmail deadlines and history recovery', () => {
  it('bounds a credential resolver that ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const s = setup(); s.token.mockImplementation(() => new Promise(() => {}));
      const request = s.client.proxyGet({ externalUserId: 'owner', accountId, url: `${base}/profile` });
      const check = expect(request).rejects.toThrow('interrupted or timed out');
      await vi.advanceTimersByTimeAsync(10_001); await check; expect(s.fetcher).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('cancels a stalled response stream at its deadline', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(); const s = setup(async () => new Response(new ReadableStream({ cancel })));
      const request = s.client.proxyGet({ externalUserId: 'owner', accountId, url: `${base}/profile` });
      const check = expect(request).rejects.toThrow('interrupted or timed out');
      await vi.advanceTimersByTimeAsync(10_001); await check; expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('marks expired history as recovery required rather than an empty result', async () => {
    const s = setup(async () => new Response(null, { status: 404 }));
    await expect(s.client.proxyGet({ externalUserId: 'owner', accountId, url: `${base}/history`, params: { startHistoryId: '9007199254740993' } })).rejects.toMatchObject({ code: 'gmail_history_expired' });
  });
  it('rejects malformed history before a caller can checkpoint it', async () => {
    const s = setup(async () => Response.json({ historyId: 9007199254740993, history: [] }));
    await expect(s.client.proxyGet({ externalUserId: 'owner', accountId, url: `${base}/history`, params: { startHistoryId: '1' } })).rejects.toThrow();
  });
});
