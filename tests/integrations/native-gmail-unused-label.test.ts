import { describe, expect, it, vi } from 'vitest';
import { createNativeGmailClient } from '../../packages/gateway/src/integrations/native-gmail/client.js';
import { executeIntegrationAction } from '../../packages/gateway/src/integrations/action-execution.js';
import { gmailApiTarget } from '../../packages/gateway/src/integrations/native-gmail/request.js';
import { GMAIL_SERVICE } from '../../packages/gateway/src/integrations/gmail.js';
const accountId = 'gmail_11111111-1111-4111-8111-111111111111';
const input = { labelId: 'Label_123', expectedName: 'Synthetic verification label' };
const label = { id: input.labelId, name: input.expectedName, type: 'user', messagesTotal: 0, threadsTotal: 0 };
function fixture(metadata: unknown = label, deleted = new Response(null, { status: 204 })) {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(deleted).mockResolvedValueOnce(new Response(null, { status: 404 }));
  const token = vi.fn(async () => 'synthetic'); const beforeSend = vi.fn(async () => undefined);
  const legacy = { proxyDelete: vi.fn() }; const client = createNativeGmailClient({ legacy: legacy as never, oauth: { token }, fetcher });
  const call = (params = input, id = accountId) => executeIntegrationAction({ pipedream: client,
    externalUserId: 'owner', connection: { pipedream_account_id: id }, def: GMAIL_SERVICE,
    actionDef: GMAIL_SERVICE.actions.delete_unused_label, serviceId: 'gmail', actionId: 'delete_unused_label', params, beforeSend });
  return { call, fetcher, token, beforeSend, legacy, client };
}
describe('native unused label cleanup', () => {
  it.each([new Response(null, { status: 204 }), Response.json({})])('preflights exact name/type/empty counts and deletes once and verifies 404 with owner admission on every send', async response => {
    const f = fixture(label, response); expect(await f.call()).toEqual({ data: { deleted: true, labelId: input.labelId } });
    expect(f.beforeSend).toHaveBeenCalledTimes(3); expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.fetcher.mock.calls[0][1].method).toBe('GET');
    expect(new URL(f.fetcher.mock.calls[0][0]).searchParams.get('fields')).toBe('id,name,type,messagesTotal,threadsTotal');
    const [url, init] = f.fetcher.mock.calls[1]; expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_123');
    expect(init).toMatchObject({ method: 'DELETE', redirect: 'error' }); expect(init.body).toBeUndefined();
    expect(f.fetcher.mock.calls[2][0]).toBe(f.fetcher.mock.calls[0][0]); expect(f.fetcher.mock.calls[2][1].method).toBe('GET');
    expect(f.legacy.proxyDelete).not.toHaveBeenCalled();
  });
  it.each([{ ...label, id: 'Label_other' }, { ...label, name: 'Other' }, { ...label, type: 'system' },
    { ...label, messagesTotal: 1 }, { ...label, threadsTotal: 1 }, { ...label, messagesTotal: undefined }])('refuses mismatched or in-use label metadata before DELETE', async metadata => {
    const f = fixture(metadata); await expect(f.call()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['INBOX', 'TRASH', '../Label_123', 'Label_123/other', 'Label_%2fother'])('rejects system or malformed target %s before token resolution', async labelId => {
    const f = fixture(); await expect(f.call({ ...input, labelId })).rejects.toThrow(); expect(f.token).not.toHaveBeenCalled();
  });
  it('revalidates admission after preflight and does not delete after withdrawal', async () => {
    const f = fixture(); f.beforeSend.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('withdrawn'));
    await expect(f.call()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not claim absence when the final read still finds a label', async () => {
    const f = fixture(); f.fetcher.mockReset().mockResolvedValueOnce(Response.json(label)).mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json(label));
    await expect(f.call()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not claim cleanup after admission is withdrawn before the absence read', async () => {
    const f = fixture(); f.beforeSend.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('withdrawn'));
    await expect(f.call()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 429, 500])('does not claim absence on final HTTP %i', async status => {
    const f = fixture(); f.fetcher.mockReset().mockResolvedValueOnce(Response.json(label)).mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response(null, { status }));
    await expect(f.call()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not claim absence on a final network error', async () => {
    const f = fixture(); f.fetcher.mockReset().mockResolvedValueOnce(Response.json(label)).mockResolvedValueOnce(Response.json({})).mockRejectedValueOnce(new Error('network'));
    await expect(f.call()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([2, 3])('keeps one deadline through token lookup %i', async tokenCall => {
    const deadlines: AbortController[] = []; const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const c = new AbortController(); deadlines.push(c); return c.signal;
    });
    try {
      const f = fixture(); let calls = 0; f.token.mockImplementation(async () => { if (++calls === tokenCall) deadlines[0].abort(); return 'synthetic'; });
      await expect(f.call()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(tokenCall - 1);
    } finally { timeout.mockRestore(); }
  });
  it.each(['', '  ', 'bad\nname'])('rejects invalid expected name before credentials', async expectedName => {
    const f = fixture(); await expect(f.call({ ...input, expectedName })).rejects.toThrow(); expect(f.token).not.toHaveBeenCalled();
  });
  it('keeps generic native and shared legacy proxy deletion blocked', async () => {
    const f = fixture(); const target = { externalUserId: 'owner', accountId, url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_123' };
    await expect(f.client.proxyDelete(target, f.beforeSend)).rejects.toThrow(); expect(f.token).not.toHaveBeenCalled();
    expect(() => gmailApiTarget(target, 'DELETE')).toThrow();
  });
  it('never falls back through the legacy connection', async () => {
    const f = fixture(); await expect(f.call(input, 'ap_old')).rejects.toThrow();
    expect(f.token).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.legacy.proxyDelete).not.toHaveBeenCalled();
  });
  it('never retries an ambiguous deletion', async () => {
    const f = fixture(); f.fetcher.mockReset().mockResolvedValueOnce(Response.json(label)).mockRejectedValueOnce(new Error('unknown outcome'));
    await expect(f.call()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not treat a nonempty successful DELETE response as proof', async () => {
    const f = fixture(label, Response.json({ unexpected: true })); await expect(f.call()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
});
