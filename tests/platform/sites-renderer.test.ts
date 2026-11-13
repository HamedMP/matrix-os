import { expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { APP_CSP, PRIVATE_APP_CSP, siteAccessGate, siteEmailGate, siteFrame, sitePage } from '../../packages/platform/src/sites/renderer.js';
import type { SiteRecord } from '@matrix-os/contracts';
const site: SiteRecord = { id: 'a2fd72d0-0926-49d5-b45f-bbfb167e50d2', appSlug: 'launch', title: '<script>bad()</script>', description: '', slug: null, url: 'https://matrix.page/a2fd72d0-0926-49d5-b45f-bbfb167e50d2', revision: 1, status: 'published', accessMode: 'public', activeVersion: 'cd0a12e9-18a0-4b4e-9a10-269eb5697d4f', versions: [], config: { data: {}, forms: [] } };
it('keeps the email Clerk component and exchange on the exact canonical app URL with a separate gate CSP', () => {
 const gate=siteEmailGate(site.id,'pk_test_existing_matrix_instance');
 expect(gate.html).toContain(`https://matrix.page/${site.id}`);
 expect(gate.html).toContain("canonical+'/access/email'");
 expect(gate.html).toContain('clerk.matrix-os.com');
 expect(gate.html).toContain('mountSignIn');
 expect(gate.html).toContain('mountSignUp');
 expect(gate.html).toContain('session.getToken');
 expect(gate.html).not.toMatch(/app\.matrix-os\.com|api\/auth\/app-session|billing|onboarding|provision-runtime/);
 expect(gate.csp).toContain('clerk.matrix-os.com');
 expect(gate.csp).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
 expect(gate.csp).toMatch(/connect-src [^;]*https:\/\/challenges\.cloudflare\.com/);
 expect(gate.csp).toContain('frame-src https://challenges.cloudflare.com');
 expect(gate.csp).toContain("worker-src 'self' blob:");
 expect(APP_CSP).not.toContain('clerk.matrix-os.com');
 expect(PRIVATE_APP_CSP).not.toContain('clerk.matrix-os.com');
 expect(APP_CSP).not.toContain('challenges.cloudflare.com');
 expect(PRIVATE_APP_CSP).not.toContain('challenges.cloudflare.com');
 expect(gate.html).not.toContain(site.title);
});
it('reuses an existing Matrix Clerk session and exchanges only at that app URL', async () => {
 const exchange=vi.fn(async(_url:unknown,_init?:RequestInit)=>new Response('{}',{status:404}));
 const mount=vi.fn();
 const clerk={load:vi.fn(async()=>{}),addListener:vi.fn(),session:{id:'sess_existing',getToken:vi.fn(async()=> 'signed.clerk.token')},mountSignIn:mount,mountSignUp:vi.fn()};
 const dom=new JSDOM(siteEmailGate(site.id,'pk_test_existing_matrix_instance').html,{url:site.url,runScripts:'dangerously',beforeParse(window){
  Object.defineProperty(window,'Clerk',{value:clerk});
  Object.defineProperty(window,'AbortSignal',{value:AbortSignal});
  Object.defineProperty(window,'fetch',{value:exchange});
 }});
 try{
  await vi.waitFor(()=>expect(exchange).toHaveBeenCalledOnce());
  expect(exchange.mock.calls[0]?.[0]).toBe(`${site.url}/access/email`);
  expect(exchange.mock.calls[0]?.[1]).toMatchObject({method:'POST',body:'{}',credentials:'same-origin',redirect:'error'});
  expect(exchange.mock.calls[0]?.[1]?.headers).toMatchObject({Authorization:'Bearer signed.clerk.token'});
  expect(mount).not.toHaveBeenCalled();
  expect(dom.window.document.querySelector('.error')?.textContent).toContain('does not have access');
 }finally{dom.window.close()}
});
it('lets the same Clerk session retry a temporary exchange failure without reloading', async () => {
 const exchange=vi.fn().mockResolvedValueOnce(new Response('{}',{status:503})).mockResolvedValueOnce(new Response('{}',{status:404}));
 const clerk={load:vi.fn(async()=>{}),addListener:vi.fn(),session:{id:'sess_existing',getToken:vi.fn(async()=> 'signed.clerk.token')},mountSignIn:vi.fn(),mountSignUp:vi.fn()};
 const dom=new JSDOM(siteEmailGate(site.id,'pk_test_existing_matrix_instance').html,{url:site.url,runScripts:'dangerously',beforeParse(window){
  Object.defineProperty(window,'Clerk',{value:clerk});Object.defineProperty(window,'AbortSignal',{value:AbortSignal});Object.defineProperty(window,'fetch',{value:exchange});
 }});
 try{
  await vi.waitFor(()=>expect(exchange).toHaveBeenCalledOnce());
  const retry=dom.window.document.getElementById('retry-access') as HTMLButtonElement;
  await vi.waitFor(()=>expect(retry.hidden).toBe(false));
  retry.click();
  await vi.waitFor(()=>expect(exchange).toHaveBeenCalledTimes(2));
  expect(clerk.session.getToken).toHaveBeenCalledTimes(2);
 }finally{dom.window.close()}
});
it('bounds a stalled Clerk account switch and keeps a visible retry path', async () => {
 const clerk={load:vi.fn(async()=>{}),addListener:vi.fn(),session:{id:'sess_existing',getToken:vi.fn(async()=> 'signed.clerk.token')},mountSignIn:vi.fn(),mountSignUp:vi.fn(),signOut:vi.fn(()=>new Promise<void>(()=>{}))};
 const dom=new JSDOM(siteEmailGate(site.id,'pk_test_existing_matrix_instance').html,{url:site.url,runScripts:'dangerously',beforeParse(window){
  Object.defineProperty(window,'Clerk',{value:clerk});Object.defineProperty(window,'AbortSignal',{value:AbortSignal});
  Object.defineProperty(window,'fetch',{value:vi.fn(async(url:unknown)=>{
   if(String(url).includes('/sign-out')){
    window.setTimeout=((handler: TimerHandler)=>{queueMicrotask(()=>{if(typeof handler==='function')handler()});return 1}) as typeof window.setTimeout;
    return new Response('{}',{status:200});
   }
   return new Response('{}',{status:404});
  })});
 }});
 try{
  await vi.waitFor(()=>expect((dom.window.document.getElementById('switch-account') as HTMLButtonElement).hidden).toBe(false));
  (dom.window.document.getElementById('switch-account') as HTMLButtonElement).click();
  await vi.waitFor(()=>expect(clerk.signOut).toHaveBeenCalledOnce());
  await vi.waitFor(()=>expect(dom.window.document.querySelector('.error')?.textContent).toContain('Unable to switch accounts'));
 }finally{dom.window.close()}
});
it('claims the current fragment when a fresh one-time link replaces a failed link in the same tab', async () => {
 const firstId='11111111-1111-4111-8111-111111111111', secondId='22222222-2222-4222-8222-222222222222';
 const firstToken='a'.repeat(43), secondToken='b'.repeat(43), bodies:string[]=[];
 const dom=new JSDOM(siteAccessGate(),{url:`${site.url}#access=${firstId}.${firstToken}`,runScripts:'dangerously',beforeParse(window){
  Object.defineProperty(window,'AbortSignal',{value:AbortSignal});
  Object.defineProperty(window,'fetch',{value:vi.fn(async(_url:unknown,init?:RequestInit)=>{bodies.push(String(init?.body));return new Response('{}',{status:404});})});
 }});
 try{
  const button=dom.window.document.querySelector('button')!;
  button.click();
  await vi.waitFor(()=>expect(bodies).toHaveLength(1));
  await vi.waitFor(()=>expect(button.disabled).toBe(false));
  dom.window.location.hash=`#access=${secondId}.${secondToken}`;
  button.click();
  await vi.waitFor(()=>expect(bodies).toHaveLength(2));
  expect(JSON.parse(bodies[1]!)).toEqual({linkId:secondId,token:secondToken});
 }finally{dom.window.close()}
});
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
it('sends the site-scoped viewer cookie when a private wrapper submits a declared form', () => {
    const page=sitePage({...site,accessMode:'private_link'});
    expect(page).toContain("credentials:'same-origin'");
    expect(page).not.toContain("credentials:'include'");
});
it('keeps the opaque iframe without credentialed private asset requests',()=>{
 const privateSite={...site,accessMode:'private_link' as const};
 const frame=siteFrame('<html><head><script type="module">import "matrix-site:app.js"</script></head></html>',privateSite,'index.html',true);
 expect(frame).not.toContain('crossorigin="use-credentials"');
 expect(frame).toContain(`<base href="https://matrix.page/${site.id}/frame">`);
 expect(PRIVATE_APP_CSP).toContain("script-src 'unsafe-inline' data:");
 expect(PRIVATE_APP_CSP).toContain("style-src 'unsafe-inline' data:");
 expect(APP_CSP).not.toContain('allow-same-origin');
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
