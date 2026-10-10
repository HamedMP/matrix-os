import { expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { APP_CSP, siteFrame, sitePage } from '../../packages/platform/src/sites/renderer.js';
import type { SiteRecord } from '@matrix-os/contracts';
const site: SiteRecord = { id: 'a2fd72d0-0926-49d5-b45f-bbfb167e50d2', appSlug: 'launch', title: '<script>bad()</script>', description: '', slug: null, url: 'https://matrix.page/a2fd72d0-0926-49d5-b45f-bbfb167e50d2', revision: 1, status: 'published', activeVersion: 'cd0a12e9-18a0-4b4e-9a10-269eb5697d4f', versions: [], config: { data: {}, forms: [] } };
it.each(['TypeError', 'Error', 'UnknownError'])('logs only a coarse %s category when public submission fails', async category => {
 const warn = vi.fn(), postMessage = vi.fn(), close = vi.fn();
 const dom = new JSDOM(sitePage(site), { url: site.url, runScripts: 'dangerously', beforeParse(window) {
  window.console.warn = warn;
  Object.defineProperty(window, 'AbortSignal', { value: AbortSignal });
  Object.defineProperty(window, 'fetch', { value: vi.fn(async () => {
   throw category === 'TypeError' ? new window.TypeError('private visitor details') : category === 'Error' ? new window.Error('private visitor details') : 'private visitor details';
  }) });
 } });
 try {
  const frame = dom.window.document.querySelector('iframe')!;
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: frame.contentWindow,
   origin: 'null', data: { type: 'matrix-site-submit', formId: 'rsvp', fields: { email: 'private@example.com' }, idempotencyKey: 'valid-submission-key' },
   ports: [{ postMessage, close } as unknown as MessagePort],
  }));
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ error: 'Submissions are unavailable' }));
  expect(warn).toHaveBeenCalledExactlyOnceWith('[sites] submission failed', category);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  expect(close).toHaveBeenCalledOnce();
 } finally { dom.window.close(); }
});
it('keeps app head intact while inserting bridge before any app script', () => {
    const result = siteFrame('<!doctype html><html><head><title>Event</title><script type="module" src="./assets/main.js"></script></head><body><form>RSVP</form></body></html>', site);
    expect(result.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(result.match(/<html>/g)).toHaveLength(1);
    expect(result.indexOf('window.MatrixOS')).toBeLessThan(result.indexOf('type="module"'));
    expect(result).toContain('<title>Event</title>');
});
it('permits form submit events inside opaque sandbox and verifies exact frame source', () => {
    const page = sitePage(site);
    expect(page).toContain('sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"');
    expect(page).toContain('event.source!==frame.contentWindow');
    expect(page).toContain('&lt;script&gt;');
});
it('opens guide links with no opener and preserves in-page anchors without granting private access', () => {
 const dom = new JSDOM(siteFrame('<head></head><body><a id="post" href="https://matrix-os.com/community">Posts</a><a id="other" href="https://matrix.page/other-guide" rel="opener nofollow">Another guide</a><a id="toc" href="#support">Support</a><h2 id="support">Support Matrix</h2></body>', site), { url: site.url + '/frame', runScripts: 'dangerously', beforeParse(window) { Object.defineProperty(window, 'TextDecoder', { value: TextDecoder }); } });
 try {
  const { document, MouseEvent } = dom.window;
  const post = document.getElementById('post')!;
  post.addEventListener('click', event => event.preventDefault());
  post.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(post.getAttribute('target')).toBe('_blank');
  expect(post.getAttribute('rel')).toBe('noopener noreferrer');
  const anchor = new MouseEvent('click', { bubbles: true, cancelable: true });
  document.getElementById('toc')!.addEventListener('click', event => event.preventDefault());
  document.getElementById('toc')!.dispatchEvent(anchor);
  expect(document.getElementById('toc')!.getAttribute('href')).toBe(site.url + '/frame#support');
  document.getElementById('toc')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(document.getElementById('toc')!.getAttribute('target')).toBeNull();
  const other = document.getElementById('other')!;
  other.addEventListener('auxclick', event => event.preventDefault());
  other.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
  expect(other.getAttribute('target')).toBe('_blank');
  expect(other.getAttribute('rel')).toBe('nofollow noopener noreferrer');
  expect(APP_CSP).toContain('sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox;');
  expect(APP_CSP).not.toContain('allow-same-origin'); expect(APP_CSP).not.toContain('allow-top-navigation');
 } finally { dom.window.close(); }
});
