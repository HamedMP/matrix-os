import { desktopFonts, desktopPalette, palette } from '@matrix-os/brand/tokens';
import { rabbitMarkSvg } from '@matrix-os/brand/marks';

function attr(value: string) { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

/** Shared platform linking page, independent of the owner's OS presentation. */
export function whatsappConnectPage(publishableKey: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect WhatsApp · Matrix OS</title>
  <style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:${desktopPalette.paper};color:${desktopPalette.forest};font-family:${desktopFonts.display}}
  main{width:100%;max-width:460px;padding:32px;border:1px solid ${palette.border};border-radius:24px;background:${desktopPalette.paper}}.mark{width:48px;height:48px}h1{font-size:30px;line-height:1.15;margin:24px 0 12px}p{line-height:1.5;color:${desktopPalette.textMuted}}button,input{font:inherit;width:100%;border-radius:12px;padding:14px;border:1px solid ${palette.border};margin-top:12px}button{background:${desktopPalette.forest};color:${desktopPalette.paper};cursor:pointer}button:disabled{opacity:.5;cursor:wait}button.secondary{background:transparent;color:${desktopPalette.forest}}label{display:block;margin-top:20px}input{background:transparent;color:inherit;letter-spacing:.2em}a{color:inherit}#status{min-height:48px}footer{font-size:13px;margin-top:24px}
  </style></head><body><main><div class="mark">${rabbitMarkSvg('mark')}</div><h1>Your Matrix agent,<br>on WhatsApp.</h1>
  <p>Send a message to Matrix and continue with your own agent, connected to your own computer.</p>
  <div id="auth"></div><button id="sign-up" class="secondary" hidden>Create a Matrix account</button>
  <section id="connection" hidden><p id="account"></p><p id="permissions">Connecting lets your general Matrix agent respond and act through WhatsApp with its existing Matrix Chat permissions. Anyone who can use your WhatsApp account can reach this agent. You can disconnect here or send STOP.</p>
  <button id="claim" hidden>Send me a connection code</button>
  <form id="confirm" hidden><label for="code">Code sent to your WhatsApp</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required placeholder="000000"><button type="submit">Connect my agent</button></form>
  <button id="disconnect" class="secondary" hidden>Disconnect WhatsApp</button><a id="open" href="/" hidden>Open Matrix</a></section>
  <p id="status" role="status" aria-live="polite">Sign in to link your Matrix account.</p><footer>Messages go to your private Matrix Chat. Text messages are supported. <a href="https://discord.gg/cSBBQWtPwV" rel="noreferrer">Contact our team</a></footer></main>
  <script nonce="${nonce}">
  const el=id=>document.getElementById(id); const token=new URL(location.href).searchParams.get('token'); const validToken=token&&/^[A-Za-z0-9_-]{43}$/.test(token); let busy=false;
  function status(text){el('status').textContent=text}function setBusy(value){busy=value;document.querySelectorAll('button').forEach(b=>{b.disabled=value})}
  async function request(path,method,payload){const bearer=await window.Clerk.session.getToken();if(!bearer)throw new Error('auth');const r=await fetch(path,{method,credentials:'omit',headers:{Authorization:'Bearer '+bearer,...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('request');return r.json()}
  async function action(fn,desiredConnection){if(busy)return;setBusy(true);try{await fn()}catch(error){
    if(typeof desiredConnection==='boolean'){try{const info=await request('/api/whatsapp/connection','GET');if(info.connected===desiredConnection){if(info.connected)connected(info);else disconnected();return}}catch(reconciliationError){console.warn('Could not refresh WhatsApp connection state.')}}
    status('Could not finish connecting. Check the code, or send Matrix a new message for a fresh link.')
  }finally{setBusy(false)}}
  function connected(info){el('claim').hidden=true;el('confirm').hidden=true;el('permissions').hidden=true;el('disconnect').hidden=false;el('open').hidden=false;status('Connected to '+info.maskedSender+'. Message Matrix on WhatsApp to reach your agent.');history.replaceState(null,'','/whatsapp/connect')}
  el('claim').onclick=()=>action(async()=>{const r=await request('/api/whatsapp/claim','POST',{token});el('claim').hidden=true;el('confirm').hidden=false;status('We sent a code to '+r.maskedSender+'. Enter it here to connect your agent.');el('code').focus()});
  function disconnected(){el('disconnect').hidden=true;el('open').hidden=false;status('Disconnected. Send a new message to Matrix on WhatsApp whenever you want to reconnect.')}
  el('confirm').onsubmit=e=>{e.preventDefault();action(async()=>{const r=await request('/api/whatsapp/confirm','POST',{token,code:el('code').value,consentVersion:'whatsapp-general-agent-v1'});connected(r)},true)};
  el('disconnect').onclick=()=>action(async()=>{await request('/api/whatsapp/connection','DELETE');disconnected()},false);
  function mountAuth(signup){const settings={forceRedirectUrl:location.href,appearance:{variables:{colorPrimary:'${desktopPalette.forest}',colorBackground:'${desktopPalette.paper}',colorText:'${desktopPalette.forest}',borderRadius:'12px'}}};window.Clerk.unmountSignIn(el('auth'));window.Clerk.unmountSignUp(el('auth'));if(signup)window.Clerk.mountSignUp(el('auth'),settings);else window.Clerk.mountSignIn(el('auth'),settings);el('sign-up').textContent=signup?'Sign in instead':'Create a Matrix account';el('sign-up').onclick=()=>mountAuth(!signup)}
  async function ready(){try{await window.Clerk.load();if(!window.Clerk.session){mountAuth(false);el('sign-up').hidden=false;return}el('connection').hidden=false;el('account').textContent='Signed in as '+(window.Clerk.user.primaryEmailAddress?.emailAddress||'your Matrix account');const info=await request('/api/whatsapp/connection','GET');if(info.connected){connected(info);return}if(validToken){el('claim').hidden=false;status('Confirm your WhatsApp number to connect your agent.')}else{status('First send a message to Matrix on WhatsApp, then open the connection link you receive.')}}catch(error){status('Sign-in is temporarily unavailable. Please try again.')}}
  window.addEventListener('load',ready);
  </script><script nonce="${nonce}" async crossorigin="anonymous" data-clerk-publishable-key="${attr(publishableKey)}" src="https://clerk.matrix-os.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script></body></html>`;
}
