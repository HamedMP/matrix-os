import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { whatsappConnectPage } from '../../packages/platform/src/whatsapp/connect-page.js';

let document: JSDOM | undefined;
afterEach(() => { document?.window.close(); document = undefined; });

function page(initiallyConnected: boolean) {
  let connected = initiallyConnected;
  const fetch = vi.fn(async (path: string, options: { method: string }) => {
    if (path.endsWith('/confirm')) { connected = true; throw new TypeError('Response connection lost'); }
    if (options.method === 'DELETE') { connected = false; throw new TypeError('Response connection lost'); }
    const data = path.endsWith('/claim') ? { maskedSender: '••••4567' }
      : connected ? { connected: true, maskedSender: '••••4567' } : { connected: false };
    return { ok: true, json: async () => data };
  });
  document = new JSDOM(whatsappConnectPage('pk_test_example', 'nonce'), {
    url: `https://app.example.com/whatsapp/connect?token=${'a'.repeat(43)}`, runScripts: 'dangerously',
    beforeParse(window) {
      Object.assign(window, { fetch, AbortSignal: globalThis.AbortSignal, Clerk: {
        load: async () => {}, session: { getToken: async () => 'owner-token' },
        user: { primaryEmailAddress: { emailAddress: 'owner@example.com' } },
      } });
    },
  });
  return { window: document.window, el: (id: string) => document!.window.document.getElementById(id)!, fetch };
}

describe('WhatsApp connection response recovery', () => {
  it('shows authoritative linked state when confirmation commits but the reply is lost', async () => {
    const { window, el, fetch } = page(false);
    await vi.waitFor(() => expect((el('claim') as HTMLButtonElement).hidden).toBe(false));
    (el('claim') as HTMLButtonElement).click();
    await vi.waitFor(() => expect((el('confirm') as HTMLFormElement).hidden).toBe(false));
    (el('code') as HTMLInputElement).value = '123456';
    el('confirm').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(el('status').textContent).toContain('Connected to'));
    expect((el('confirm') as HTMLFormElement).hidden).toBe(true);
    expect((el('disconnect') as HTMLButtonElement).hidden).toBe(false);
    expect(window.location.search).toBe('');
    expect(fetch.mock.calls.filter(([path]) => path.endsWith('/connection'))).toHaveLength(2);
  });
  it('shows authoritative disconnected state when deletion commits but the reply is lost', async () => {
    const { el } = page(true);
    await vi.waitFor(() => expect((el('disconnect') as HTMLButtonElement).hidden).toBe(false));
    (el('disconnect') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(el('status').textContent).toContain('Disconnected.'));
    expect((el('disconnect') as HTMLButtonElement).hidden).toBe(true);
  });
});
