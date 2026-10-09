import type { SiteRecord } from '@matrix-os/contracts';
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
export function sitePage(site: SiteRecord): string {
    const reference = site.id;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(site.title)}</title><meta name="description" content="${escape(site.description)}"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{background:#fff}</style></head><body><iframe title="${escape(site.title)}" sandbox="${SANDBOX}" referrerpolicy="no-referrer" src="/${reference}/frame"></iframe><script>
const frame=document.querySelector('iframe');let inFlight=false;
window.addEventListener('message',async(event)=>{
 if(event.source!==frame.contentWindow||event.origin!=='null'||event.ports.length!==1)return;
 const port=event.ports[0];const payload=event.data;
 if(!payload||payload.type!=='matrix-site-submit'||typeof payload.formId!=='string'||payload.formId.length>64||typeof payload.idempotencyKey!=='string'||payload.idempotencyKey.length>128){port.close();return}
 if(inFlight){port.postMessage({error:'Try again later'});port.close();return}
 inFlight=true;
 try{const body=JSON.stringify({fields:payload.fields,idempotencyKey:payload.idempotencyKey});if(body.length>65536)throw Error();
 const response=await fetch('/${reference}/forms/'+encodeURIComponent(payload.formId),{method:'POST',headers:{'Content-Type':'application/json'},body,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
 port.postMessage(response.ok?{accepted:true}:{error:response.status===429?'Try again later':'Submissions are unavailable'});
 }catch(error){console.warn('[sites] submission failed',error instanceof TypeError?'TypeError':error instanceof Error?'Error':'UnknownError');port.postMessage({error:'Submissions are unavailable'})}finally{inFlight=false;port.close()}
});</script></body></html>`;
}
export function siteFrame(html: string, site: SiteRecord): string {
    const bootstrap = `<base href="https://matrix.page/${site.id}/assets/${site.activeVersion}/"><script>
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
})})})})();</script>`;
    // Bootstrap must precede all app code; the opaque origin only has this public bridge.
    if (/<head(?:\s[^>]*)?>/i.test(html))
        return html.replace(/<head(?:\s[^>]*)?>/i, head => `${head}${bootstrap}`);
    if (/<html(?:\s[^>]*)?>/i.test(html))
        return html.replace(/<html(?:\s[^>]*)?>/i, root => `${root}<head>${bootstrap}</head>`);
    return `<!doctype html><html><head>${bootstrap}</head><body>${html.replace(/<!doctype[^>]*>/gi, '')}</body></html>`;
}
export const APP_CSP = `sandbox ${SANDBOX}; default-src 'none'; script-src https://matrix.page 'unsafe-inline'; style-src https://matrix.page 'unsafe-inline'; img-src https://matrix.page data:; font-src https://matrix.page; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri https://matrix.page; frame-ancestors https://matrix.page`;
export const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
