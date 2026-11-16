import { randomBytes } from 'node:crypto';
import { SiteIdSchema } from '@matrix-os/contracts';
import { desktopFonts, desktopPalette } from '@matrix-os/brand/tokens';
import { CLERK_SCRIPT_ORIGIN } from '../auth-pages.js';

export function emailAuthPageContext(siteId: string, publishableKey: string) {
    const id = SiteIdSchema.parse(siteId);
    if (!/^pk_(?:live|test)_[A-Za-z0-9_-]{8,512}$/.test(publishableKey))
        throw new Error('Invalid Clerk publishable key');
    const nonce = randomBytes(18).toString('base64');
    const canonical = `https://matrix.page/${id}`;
    const captchaOrigin = 'https://challenges.cloudflare.com';
    const csp = `default-src 'none'; script-src 'nonce-${nonce}' ${CLERK_SCRIPT_ORIGIN} ${captchaOrigin}; style-src 'unsafe-inline' ${CLERK_SCRIPT_ORIGIN}; img-src data: ${CLERK_SCRIPT_ORIGIN}; font-src data: ${CLERK_SCRIPT_ORIGIN}; connect-src 'self' ${CLERK_SCRIPT_ORIGIN} ${captchaOrigin}; form-action 'self' ${CLERK_SCRIPT_ORIGIN}; frame-src 'self' ${captchaOrigin}; worker-src 'self' blob:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`;
    const clerkScript = `<script id="clerk-script" nonce="${nonce}" async crossorigin="anonymous" data-clerk-publishable-key="${publishableKey}" src="${CLERK_SCRIPT_ORIGIN}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`;
    return { canonical, nonce, csp, clerkScript };
}

/** Runs in the trusted Matrix.page parent, never in the opaque app frame. */
export const EMAIL_SESSION_SCRIPT = `
let endingSession=false;
async function withDeadline(operation){let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=window.setTimeout(()=>reject(Error('timeout')),10000)})])}finally{if(timer!==undefined)window.clearTimeout(timer)}}
async function endEmailSession(onRevoked){
 const session=window.Clerk?.session;if(!session)throw Error();
 const token=await withDeadline(session.getToken({skipCache:true}));if(!token)throw Error();
 const response=await fetch(canonical+'/access/email/sign-out',{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:'{}',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error();if(onRevoked)onRevoked();
 await withDeadline(window.Clerk.signOut({redirectUrl:canonical}));
 window.location.replace(canonical)
}
`;

/** Add a real sign-out action without giving the app frame access to Clerk. */
export function siteEmailViewerPage(page: string, siteId: string, publishableKey: string): { html: string; csp: string } {
    const { canonical, nonce, csp, clerkScript } = emailAuthPageContext(siteId, publishableKey);
    const styles = `<style>body{display:flex;flex-direction:column}iframe{flex:1;min-height:0}.matrix-viewer{display:flex;align-items:center;justify-content:flex-end;gap:12px;min-height:40px;padding:0 12px;font:13px ${desktopFonts.sans};background:${desktopPalette.paper};color:${desktopPalette.forest}}.matrix-viewer button{border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;cursor:pointer}.matrix-viewer button:disabled{opacity:.5;cursor:wait}.matrix-viewer [role=alert]{color:${desktopPalette.danger}}</style>`;
    const controls = '<header class="matrix-viewer" aria-label="Shared app account"><span role="alert" aria-live="polite"></span><button id="email-sign-out" type="button" disabled>Sign out</button></header>';
    const script = `<script nonce="${nonce}">
const canonical=${JSON.stringify(canonical)};const signOut=document.getElementById('email-sign-out');const error=document.querySelector('.matrix-viewer [role=alert]');
${EMAIL_SESSION_SCRIPT}
signOut.addEventListener('click',async()=>{
 if(endingSession)return;endingSession=true;signOut.disabled=true;error.textContent='';
 try{await endEmailSession(()=>{document.querySelector('iframe')?.remove()})}
 catch(failure){console.warn('[sites] viewer sign-out unavailable',failure instanceof Error?'Error':'UnknownError');error.textContent='Unable to sign out right now. Try again.';endingSession=false;signOut.disabled=false}
});
async function init(){try{await withDeadline(window.Clerk.load({signInUrl:canonical,signUpUrl:canonical}));signOut.disabled=false}
 catch(failure){console.warn('[sites] viewer account unavailable',failure instanceof Error?'Error':'UnknownError');error.textContent='Account controls are unavailable. Reload to try again.'}}
if(window.Clerk)void init();else document.getElementById('clerk-script').addEventListener('load',()=>void init());
document.getElementById('clerk-script').addEventListener('error',()=>{error.textContent='Account controls are unavailable. Reload to try again.'});
</script>`;
    const html = page.replaceAll('<script>', `<script nonce="${nonce}">`)
        .replace('</head>', `${styles}</head>`).replace('<body>', `<body>${controls}`)
        .replace('</body>', `${clerkScript}${script}</body>`);
    return { html, csp };
}
