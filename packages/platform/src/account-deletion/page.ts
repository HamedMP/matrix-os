import { palette as c, fonts, radii, cardShadow } from '@matrix-os/brand/tokens';
import { escapeHtmlAttr, CLERK_SCRIPT_ORIGIN } from '../auth-pages.js';
export function getAccountDeletionPage(options:{nonce:string;publishableKey?:string}):string {
 const key=escapeHtmlAttr(options.publishableKey??'');
 const nonce=escapeHtmlAttr(options.nonce);
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Delete your account | Matrix OS</title><style>
 *{box-sizing:border-box}body{margin:0;background:${c.pageBg};color:${c.deep};font-family:${fonts.sans};line-height:1.6}main{max-width:42rem;margin:4rem auto;padding:2rem;background:${c.card};border:1px solid ${c.border};border-radius:${radii.card};box-shadow:${cardShadow}}h1{font-family:${fonts.display};font-weight:400;font-size:2.5rem;line-height:1.2}h2{font-size:1.15rem}a{color:${c.forest}}button{font:inherit;padding:.7rem 1rem;border:1px solid ${c.border};border-radius:${radii.control};background:${c.forest};color:${c.card};cursor:pointer}button:disabled{opacity:.5;cursor:wait}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid ${c.ember};outline-offset:3px}.danger{background:${c.ember}}#error{color:${c.ember}}#downloads a{display:block;padding:.5rem 0}label{display:block;margin:1rem 0}.actions{display:flex;gap:.75rem;flex-wrap:wrap}[hidden]{display:none!important}@media(max-width:48rem){main{margin:1rem;padding:1.5rem}}
 </style></head><body><main><a href="/runtime">Matrix OS</a><h1>Delete your account</h1>
 <p>Your account and personal data will be permanently removed. Deletion starts after <strong>five days</strong>. Final backup cleanup can take an additional day while existing upload links expire. You can cancel during the five-day grace period.</p>
 <p>Future subscription billing stops when the request is accepted. There is no automatic refund. Cancelling deletion does not restart your subscription.</p>
 <p>Download your data or finish migration before the deadline. Existing computers remain accessible during the grace period. Transfer ownership of organizations and shared projects first; other members’ data stays with them.</p>
 <p id="status" role="status" aria-live="polite">Sign in to manage your account.</p><p id="error" role="alert"></p>
 <p id="apple-revocation">If you used Sign in with Apple, after your Matrix account is deleted, check your Apple Account and remove Matrix OS if it is still listed. Follow <a href="https://support.apple.com/102571" rel="noreferrer">Apple’s instructions</a>. Removing Apple access alone does not delete your Matrix account.</p>
 <button id="signin" type="button">Sign in</button><section id="account" hidden><h2>Keep a copy of your data</h2><div class="actions"><button id="export" type="button">Download backed-up files</button><button id="platform-export" type="button">Download account records</button><a href="/runtime">Open your computers for migration</a></div><div id="downloads"></div><button id="more" type="button" hidden>Load more files</button><p id="export-note"></p>
 <div id="confirm"><label><input type="checkbox" id="ack"> I understand that deletion removes my account, computers and personal data.</label><button id="delete" class="danger" type="button" disabled>Schedule account deletion</button></div><button id="cancel" type="button" hidden>Cancel account deletion</button></section>
 </main>${options.publishableKey?`<script id="clerk-script" nonce="${nonce}" async crossorigin="anonymous" data-clerk-publishable-key="${key}" src="${CLERK_SCRIPT_ORIGIN}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`:''}
 <script nonce="${nonce}">
 const el=id=>document.getElementById(id);
 let busy=false,current=null,cursor=null;
 const controls=['delete','cancel','export','platform-export','more'];
 function failure(){el('error').textContent='The request could not be completed. Please try again.';}
 async function api(path,body){
   const token=await window.Clerk.session.getToken();if(!token)throw Error('unauthorized');
   const res=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
   if(!res.ok){let value;try{value=await res.json();}catch(error){if(!(error instanceof SyntaxError))throw error;console.warn('Unable to read account response.');}if(value&&value.code==='ownership_transfer_required')throw Error('ownership_transfer_required');throw Error('request_failed');}return res.json();
 }
 function controlsState(){
   const finished=current&&(current.status==='processing'||current.status==='completed');
   for(const id of controls)el(id).disabled=busy||finished;
   el('delete').disabled=busy||finished||!el('ack').checked;
 }
 function display(s){
   current=s;const pending=s.status==='scheduled';const finished=s.status==='processing'||s.status==='completed';
   el('confirm').hidden=pending||finished;el('cancel').hidden=!pending;
   el('status').textContent=pending?'Deletion starts on '+new Date(s.erasesAfter||s.completesBy).toLocaleString()+'. '+(s.billingStopped?'Future billing has stopped.':'Billing cancellation is pending; we will retry it automatically.'):finished?(s.status==='completed'?'Your account has been deleted.':'Your deletion is being processed. Data download and cancellation are closed.'):'No account deletion is scheduled.';
   controlsState();
 }
 async function action(work){
   if(busy)return;busy=true;el('error').textContent='';controlsState();
   try{await work();}catch(e){if(e.message==='ownership_transfer_required')el('error').textContent='Transfer organization and shared project ownership before deleting your account.';else failure();}finally{busy=false;controlsState();}
 }
 async function files(next){
   const data=await api('/api/account/delete/export'+(next?'?cursor='+encodeURIComponent(next):''));
   if(!next)el('downloads').replaceChildren();
   for(const file of data.downloads){
     const url=new URL(file.url,location.origin);if(url.protocol!=='https:'&&url.origin!==location.origin)continue;
     const a=document.createElement('a');a.textContent=file.name;a.href=url.href;a.rel='noreferrer';el('downloads').appendChild(a);
   }
   cursor=data.nextCursor||null;el('more').hidden=!cursor;el('export-note').textContent=(data.instructions||[]).join(' ');
 }
 el('ack').addEventListener('change',controlsState);
 el('delete').addEventListener('click',()=>action(async()=>display(await api('/api/account/delete',{confirm:true}))));
 el('cancel').addEventListener('click',()=>action(async()=>display(await api('/api/account/delete/cancel',{confirm:true}))));
 el('export').addEventListener('click',()=>action(()=>files(null)));
 el('more').addEventListener('click',()=>action(()=>files(cursor)));
 el('platform-export').addEventListener('click',()=>action(async()=>{
   const data=await api('/api/account/delete/export/platform');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
   try{const a=document.createElement('a');a.href=url;a.download='matrix-account.json';a.click();}finally{URL.revokeObjectURL(url);}
 }));
 el('signin').addEventListener('click',()=>location.assign('/sign-in?redirect_url='+encodeURIComponent('/account/delete')));
 async function boot(){try{if(!window.Clerk)throw Error('missing');await window.Clerk.load();if(!window.Clerk.session)return;display(await api('/api/account/delete'));el('signin').hidden=true;el('account').hidden=false;}catch(e){failure();}}
 const script=el('clerk-script');if(window.Clerk)boot();else if(script){script.addEventListener('load',boot);script.addEventListener('error',failure);}else{el('signin').disabled=true;failure();}
 </script></body></html>`;
}
