import type { SiteRecord } from '@matrix-os/contracts';
import { desktopFonts, desktopPalette } from '@matrix-os/brand/tokens';
import { CLERK_SATELLITE_LOAD, emailAuthPageContext, EMAIL_SESSION_SCRIPT } from './email-auth-page.js';
import { frameDataBridge, pageDataHandler } from './renderer-data-bridge.js';
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
/** This page is intentionally independent of Matrix onboarding and runtime auth. */
export function siteEmailGate(siteId: string, publishableKey: string): { html: string; csp: string } {
    const { canonical, nonce, csp, clerkScript, signInHref, signUpHref } = emailAuthPageContext(siteId, publishableKey);
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open shared Matrix app</title><style>
html,body{margin:0;min-height:100%;font-family:${desktopFonts.sans};background:${desktopPalette.canvas};color:${desktopPalette.forest}}body{display:grid;place-items:center;padding:24px;box-sizing:border-box}.card{width:min(100%,440px);border:1px solid ${desktopPalette.blue};border-radius:16px;background:${desktopPalette.paper};padding:28px;box-sizing:border-box;box-shadow:0 16px 48px rgba(14,52,34,.12)}h1{margin:0 0 10px;font-size:24px}p{line-height:1.5;color:${desktopPalette.textMuted}}button,.auth-link{border:0;border-radius:10px;background:${desktopPalette.forest};color:${desktopPalette.paper};padding:10px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}.auth-link[hidden]{display:none}.actions{display:flex;gap:8px;flex-wrap:wrap}.error{min-height:24px;color:${desktopPalette.danger};font-size:14px}
</style></head><body><main class="card"><h1>Open shared Matrix app</h1><p>Sign in with the email address this app was shared with.</p><p class="error" role="alert" aria-live="polite"></p><div class="actions"><a class="auth-link" href="${signUpHref}">Create account</a><a class="auth-link" href="${signInHref}">Sign in</a><button id="switch-account" type="button" hidden>Use another account</button><button id="retry-access" type="button" hidden>Try again</button></div></main>
${clerkScript}
<script nonce="${nonce}">
const canonical=${JSON.stringify(canonical)};const error=document.querySelector('.error');const retry=document.getElementById('retry-access');
const authLinks=document.querySelectorAll('.auth-link');
let exchanging=false;let attemptedSession=null;
function signedIn(){authLinks.forEach(link=>{link.hidden=true});document.getElementById('switch-account').hidden=false}
function showError(message){error.textContent=message}
${EMAIL_SESSION_SCRIPT}
async function exchange(){
 const session=window.Clerk?.session;
 if(!session||endingSession||exchanging||attemptedSession===session.id)return;
 exchanging=true;attemptedSession=session.id;retry.hidden=true;showError('');
 try{const token=await withDeadline(session.getToken({skipCache:true}));if(!token)throw Error();
  const response=await fetch(canonical+'/access/email',{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:'{}',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(endingSession)return;
  if(!response.ok){if(response.status!==404)attemptedSession=null;retry.hidden=false;showError(response.status===404?'This account does not have access. Use another account or ask the publisher to invite you.':'Unable to open this app right now.');return}
  window.location.replace(canonical)
 }catch(failure){attemptedSession=null;retry.hidden=false;console.warn('[sites] email access failed',failure instanceof TypeError?'TypeError':failure instanceof Error?'Error':'UnknownError');showError('Unable to open this app right now.')}
 finally{exchanging=false}
}
async function init(){try{await withDeadline(window.Clerk.load(${CLERK_SATELLITE_LOAD}));
 window.Clerk.addListener(()=>{if(window.Clerk.session){signedIn();void exchange()}});
 if(window.Clerk.session){signedIn();await exchange()}
 }catch(failure){console.warn('[sites] Clerk gate unavailable',failure instanceof Error?'Error':'UnknownError');showError('Unable to sign in right now.')}}
retry.addEventListener('click',()=>{attemptedSession=null;void exchange()});
document.getElementById('switch-account').addEventListener('click',async()=>{
 if(!window.Clerk?.session||endingSession)return;endingSession=true;showError('');
 try{await endEmailSession()}
 catch(failure){endingSession=false;console.warn('[sites] account switch unavailable',failure instanceof Error?'Error':'UnknownError');showError('Unable to switch accounts right now.')}});
if(window.Clerk)void init();else document.getElementById('clerk-script').addEventListener('load',()=>void init());
document.getElementById('clerk-script').addEventListener('error',()=>showError('Unable to sign in right now.'));
</script></body></html>`;
    return { html, csp };
}
export function siteAccessGate(): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared Matrix app</title><style>
html,body{margin:0;min-height:100%;font-family:${desktopFonts.sans};background:${desktopPalette.canvas};color:${desktopPalette.forest}}body{display:grid;place-items:center;padding:24px;box-sizing:border-box}.card{width:min(100%,420px);border:1px solid ${desktopPalette.blue};border-radius:16px;background:${desktopPalette.paper};padding:28px;box-sizing:border-box;box-shadow:0 16px 48px rgba(14,52,34,.12)}h1{margin:0 0 10px;font-size:24px}p{line-height:1.5;color:${desktopPalette.textMuted}}button{width:100%;border:0;border-radius:10px;background:${desktopPalette.forest};color:${desktopPalette.paper};padding:12px 16px;font:inherit;font-weight:600;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}.error{min-height:24px;color:${desktopPalette.danger};font-size:14px}
</style></head><body><main class="card"><h1>Shared Matrix app</h1><p>This app was shared through a one-time private link. Opening it gives this browser access for 30 days.</p><p class="error" role="alert" aria-live="polite"></p><button type="button">Open shared app</button></main><script>
const button=document.querySelector('button');const error=document.querySelector('.error');
const readClaim=()=>location.hash.match(/^#access=([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i);
const refresh=()=>{const available=Boolean(readClaim());button.disabled=!available;error.textContent=available?'':'This access link is unavailable.'};refresh();addEventListener('hashchange',refresh);
button.addEventListener('click',async()=>{const match=readClaim();if(!match||button.disabled)return;button.disabled=true;error.textContent='';
 try{const response=await fetch(location.pathname+'/access/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({linkId:match[1],token:match[2]}),credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error();history.replaceState(null,'',location.pathname);location.reload()}
 catch(claimError){console.warn('[sites] claim failed',claimError instanceof TypeError?'TypeError':claimError instanceof Error?'Error':'UnknownError');button.disabled=false;error.textContent='This access link is unavailable.'}});
</script></body></html>`;
}
export function sitePage(site: SiteRecord): string {
    const reference = site.id;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(site.title)}</title><meta name="description" content="${escape(site.description)}"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{background:#fff}</style></head><body><iframe title="${escape(site.title)}" sandbox="${SANDBOX}" referrerpolicy="no-referrer" src="/${reference}/frame"></iframe><script>
const frame=document.querySelector('iframe');let inFlight=false;${pageDataHandler(site)}
window.addEventListener('message',async(event)=>{
 if(event.source!==frame.contentWindow||event.origin!=='null'||event.ports.length!==1)return;
 const port=event.ports[0];const payload=event.data;${site.accessMode === 'public' ? `
 if(payload&&payload.type==='matrix-site-data'){await relayData(port,payload.request);return}` : ''}
 if(!payload||payload.type!=='matrix-site-submit'||typeof payload.formId!=='string'||payload.formId.length>64||typeof payload.idempotencyKey!=='string'||payload.idempotencyKey.length>128){port.close();return}
 if(inFlight){port.postMessage({error:'Try again later'});port.close();return}
 inFlight=true;
 try{const body=JSON.stringify({fields:payload.fields,idempotencyKey:payload.idempotencyKey});if(body.length>65536)throw Error();
 const response=await fetch('/${reference}/forms/'+encodeURIComponent(payload.formId),{method:'POST',headers:{'Content-Type':'application/json'},body,credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(10000)});
 port.postMessage(response.ok?{accepted:true}:{error:response.status===429?'Try again later':'Submissions are unavailable'});
 }catch(error){console.warn('[sites] submission failed',error instanceof TypeError?'TypeError':error instanceof Error?'Error':'UnknownError');port.postMessage({error:'Submissions are unavailable'})}finally{inFlight=false;port.close()}
});</script></body></html>`;
}
export function siteFrame(html: string, site: SiteRecord, path = 'index.html', packaged = false): string {
    const base = packaged ? `https://matrix.page/${site.id}/frame`
        : new URL('./', new URL(path, `https://matrix.page/${site.id}/assets/${site.activeVersion}/`)).href;
    const bootstrap = `<base href="${escape(base)}"><script>
(()=>{const data=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded(site.config.data)}'),c=>c.charCodeAt(0))));
const prepareLink=event=>{
 const link=event.composedPath().find(node=>node instanceof HTMLAnchorElement);
 if(!link)return;
 const raw=link.getAttribute('href');
 if(!raw)return;
 if(raw&&raw.startsWith('#')){link.href=new URL(raw,window.location.href).href;return}
 if(!URL.canParse(link.href))return;
 const destination=new URL(link.href);
 if(!['http:','https:'].includes(destination.protocol))return;
 const current=new URL(window.location.href);
 if(destination.origin===current.origin&&destination.pathname===current.pathname&&destination.search===current.search)return;
 if(destination.origin==='https://matrix.page'&&destination.pathname.startsWith('/${site.id}/assets/${site.activeVersion}/'))return;
 link.target='_blank';link.rel=link.rel.split(/\\s+/).filter(token=>token&&token!=='opener').slice(0,20).concat(['noopener','noreferrer']).join(' ');
};
document.addEventListener('click',prepareLink,true);document.addEventListener('auxclick',prepareLink,true);
window.MatrixOS=Object.freeze({site:Object.freeze({data,submit:(formId,fields,options={})=>new Promise((resolve,reject)=>{
 const channel=new MessageChannel();const timeout=setTimeout(()=>{channel.port1.close();reject(Error('Submissions are unavailable'))},11000);
 channel.port1.onmessage=event=>{clearTimeout(timeout);channel.port1.close();event.data?.accepted?resolve({accepted:true}):reject(Error(event.data?.error==='Try again later'?'Try again later':'Submissions are unavailable'))};
 parent.postMessage({type:'matrix-site-submit',formId,fields,idempotencyKey:options.idempotencyKey||crypto.randomUUID()},'https://matrix.page',[channel.port2]);
})})${frameDataBridge(site)}})})();</script>`;
    // Bootstrap must precede all app code; the opaque origin only has this public bridge.
    if (/<head(?:\s[^>]*)?>/i.test(html))
        return html.replace(/<head(?:\s[^>]*)?>/i, head => `${head}${bootstrap}`);
    if (/<html(?:\s[^>]*)?>/i.test(html))
        return html.replace(/<html(?:\s[^>]*)?>/i, root => `${root}<head>${bootstrap}</head>`);
    return `<!doctype html><html><head>${bootstrap}</head><body>${html.replace(/<!doctype[^>]*>/gi, '')}</body></html>`;
}
export const APP_CSP = `sandbox ${SANDBOX}; default-src 'none'; script-src https://matrix.page 'unsafe-inline'; style-src https://matrix.page 'unsafe-inline'; img-src https://matrix.page data:; font-src https://matrix.page; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri https://matrix.page; frame-ancestors https://matrix.page`;
export const PRIVATE_APP_CSP = `sandbox ${SANDBOX}; default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri https://matrix.page; frame-ancestors https://matrix.page`;
export const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
