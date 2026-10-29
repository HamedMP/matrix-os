import { describe, expect, it, vi } from 'vitest';
import { createNativeGmailClient } from '../../packages/gateway/src/integrations/native-gmail/client.js';

const input = { externalUserId: 'owner', accountId: 'gmail_11111111-1111-4111-8111-111111111111', kind: 'message-text', id: 'abc' };
const payload = { mimeType: 'text/plain', filename: '', body: { size: 5 } };
function fixture(first: unknown = { id: 'abc', payload }, second: unknown = { id: 'abc', payload: { ...payload, body: { size: 5, data: 'SGVsbG8' } } }) {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(second));
  const token = vi.fn(async () => 'synthetic-token'); const beforeSend = vi.fn(async () => undefined);
  const legacy = { boundedGmailGet: vi.fn() };
  const client = createNativeGmailClient({ legacy: legacy as never, oauth: { token }, fetcher });
  return { fetcher, token, beforeSend, legacy, read: (signal = new AbortController().signal) => client.boundedGmailGet!(input, signal, beforeSend) };
}
describe('native Gmail message text without attachment collection', () => {
  it('preflights MIME metadata without binary data, then fetches only an attachment-free immutable message', async () => {
    const f = fixture(); expect(await f.read()).toMatchObject({ id: 'abc', payload: { body: { data: 'SGVsbG8' } } });
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.beforeSend).toHaveBeenCalledTimes(2);
    const first = new URL(f.fetcher.mock.calls[0][0]);
    expect(first.searchParams.get('fields')).not.toMatch(/\bdata\b/);
    expect(first.pathname).toBe('/gmail/v1/users/me/messages/abc');
    expect(f.legacy.boundedGmailGet).not.toHaveBeenCalled();
  });
  it.each([
    { ...payload, filename: 'private.txt' },
    { ...payload, body: { size: 5, attachmentId: 'attachment-one' } },
    { ...payload, mimeType: 'image/png' },
    { ...payload, body: { size: 5, data: 'unexpected-data' } },
    { ...payload, headers: [{ name: 'Content-Disposition', value: 'attachment' }] },
    { mimeType: 'multipart/mixed', parts: [payload, { mimeType: 'application/pdf', filename: 'private.pdf', body: { attachmentId: 'one', size: 10 } }] },
  ])('refuses attachment-bearing, unknown, or dishonest MIME before a body fetch', async unsafe => {
    const f = fixture({ id: 'abc', payload: unsafe }); await expect(f.read()).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('rechecks owner admission before the content fetch', async () => {
    const f = fixture(); f.beforeSend.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('withdrawn'));
    await expect(f.read()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses a changed identity or MIME structure before releasing content', async () => {
    const f = fixture(undefined, { id: 'different', payload }); await expect(f.read()).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...payload, mimeType: 'text/html' },
    { ...payload, body: { size: 6, data: 'SGVsbG8h' } },
    { ...payload, filename: 'attachment.txt' },
    { ...payload, body: { size: 5, attachmentId: 'new-attachment' } },
  ])('refuses same-ID MIME changes before releasing content', async changed => {
    const f = fixture(undefined, { id: 'abc', payload: changed }); await expect(f.read()).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('supports attachment-free multipart alternatives and drops unexpected response fields', async () => {
    const p = { mimeType: 'multipart/alternative', body: { size: 0 }, parts: [payload] };
    const f = fixture({ id: 'abc', payload: p }, { id: 'abc', unexpected: 'do not release',
      payload: { ...p, extra: 'drop', parts: [{ ...payload, extra: 'drop', body: { size: 5, data: 'SGVsbG8', extra: 'drop' } }] } });
    const result = await f.read();
    expect(JSON.stringify(result)).not.toContain('drop'); expect(result).not.toHaveProperty('unexpected');
  });
  it('refuses an excessively deep MIME tree without a body fetch', async () => {
    let p: unknown = payload;
    for (let n = 0; n < 13; n++) p = { mimeType: 'multipart/alternative', parts: [p] };
    const f = fixture({ id: 'abc', payload: p }); await expect(f.read()).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...payload, body: { size: 128 * 1024 + 1 } },
    { mimeType: 'multipart/alternative', parts: Array.from({ length: 256 }, () => payload) },
    { mimeType: 'multipart/alternative', parts: Array.from({ length: 4 }, () => ({ ...payload, body: { size: 40000 } })) },
    { ...payload, body: null },
    { ...payload, headers: [{ name: 'Content-Type', value: 'text/plain; name=secret.txt' }] },
  ])('refuses oversized or malformed MIME metadata', async changed => {
    const f = fixture({ id: 'abc', payload: changed }); await expect(f.read()).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds streamed metadata even without a content length', async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65537)); c.close(); } })));
    const client = createNativeGmailClient({ legacy: {} as never, oauth: { token: async () => 'synthetic' }, fetcher });
    await expect(client.boundedGmailGet!(input)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses cancellation before the first fetch', async () => {
    const controller = new AbortController(); const f = fixture();
    f.beforeSend.mockImplementationOnce(async () => { controller.abort(); });
    await expect(f.read(controller.signal)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('keeps the original end-to-end deadline during second-request token resolution', async () => {
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController(); deadlines.push(controller); return controller.signal;
    });
    try {
      const f = fixture(); f.token.mockResolvedValueOnce('synthetic-token').mockImplementationOnce(async () => {
        deadlines[0].abort(new DOMException('Deadline', 'TimeoutError')); return 'synthetic-token';
      });
      await expect(f.read()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); }
  });
  it('does not send the native-only preflight through the old connection', async () => {
    const legacy = { boundedGmailGet: vi.fn() }; const fetcher = vi.fn();
    const client = createNativeGmailClient({ legacy: legacy as never, oauth: { token: vi.fn() }, fetcher });
    await expect(client.boundedGmailGet!({ ...input, accountId: 'ap_legacy' })).rejects.toThrow();
    expect(legacy.boundedGmailGet).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
