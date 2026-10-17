import { ACTION_FUNCTION } from './cdp-dom.js';

/** Fixed internal decoration only, in the observation's isolated world. No page text is read. */
export const CLEAR_CURSOR_FUNCTION = `function MATRIX_CLEAR_CURSOR() {
  const cursor = globalThis.__matrixBrowserCursor;
  if (cursor) { cursor.active=false; clearTimeout(cursor.timer); cursor.finish?.(); cursor.element.remove(); }
  globalThis.__matrixBrowserCursor=null;
  return {ok:true};
}`;
const DRAW_CURSOR = `
  if (['click','type','select'].includes(action)) {
    if (typeof e.scrollIntoView==='function') e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    const box=e.getBoundingClientRect(); const x=box.left+box.width/2, y=box.top+box.height/2;
    if (![x,y].every(Number.isFinite) || x<0 || y<0 || x>innerWidth || y>innerHeight) return {ok:false,reason:'stale'};
    (${CLEAR_CURSOR_FUNCTION}).call(doc);
    const layer=doc.createElement('div'); layer.setAttribute('data-matrix-agent-cursor','');
    layer.setAttribute('data-matrix-private',''); layer.setAttribute('aria-hidden','true'); layer.setAttribute('data-click',String(action==='click'));
    const styles={position:'fixed',left:Math.min(32768,x)+'px',top:Math.min(32768,y)+'px',width:'32px',height:'40px',pointerEvents:'none',zIndex:'2147483647',contain:'layout style',display:'block',visibility:'visible',opacity:'1'};
    for (const [key,value] of Object.entries(styles)) layer.style.setProperty(key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),value,'important');
    const shadow=layer.attachShadow({mode:'closed'});
    shadow.innerHTML='<style>:host{pointer-events:none}svg{overflow:visible;pointer-events:none}.pulse{animation:pulse .65s ease-out}@keyframes pulse{from{r:3;opacity:1}to{r:22;opacity:0}}</style><svg width="32" height="40" viewBox="0 0 32 40" aria-hidden="true">'+(action==='click'?'<circle class="pulse" cx="0" cy="0" r="3" fill="none" stroke="#7c3aed" stroke-width="3"/>':'')+'<path d="M0 0 L0 26 L7 20 L13 32 L19 29 L13 17 L23 17 Z" fill="#7c3aed" stroke="white" stroke-width="2"/><circle cx="25" cy="32" r="5" fill="#7c3aed" stroke="white" stroke-width="2"/></svg>';
    doc.documentElement.appendChild(layer);
    const cursor={element:layer,active:true,timer:null,finish:null}; globalThis.__matrixBrowserCursor=cursor;
    cursor.timer=setTimeout(()=>{if(globalThis.__matrixBrowserCursor===cursor) (${CLEAR_CURSOR_FUNCTION}).call(doc);},5000);
    // Two frames ensure the pointer is painted before the website action. The
    // bounded fallback also covers background or throttled Chrome tabs.
    await new Promise(resolve=>{
      let settled=false; let frame; const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);if(frame)cancelAnimationFrame(frame);cursor.finish=null;resolve();};
      cursor.finish=finish; const timeout=setTimeout(finish,120);
      frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(finish);});
    });
    if (!cursor.active || globalThis.__matrixBrowserObservation!==state || state.url!==doc.URL || !e.isConnected || e.ownerDocument!==doc || nameOf(e)!==row.name || secret(e) || e.disabled || !e.getClientRects().length || getComputedStyle(e).visibility==='hidden' || e.closest('[hidden],[inert],[aria-hidden="true"],[data-matrix-private]')) return {ok:false,reason:'stale'};
    if ((e.getAttribute('role') || (e.tagName === 'A' ? 'link' : e.tagName === 'BUTTON' ? 'button' : e.tagName === 'SELECT' ? 'combobox' : 'textbox')).slice(0,40)!==row.role) return {ok:false,reason:'stale'};
    if (doc.querySelector('[data-matrix-owner-handoff]') || Array.from(doc.querySelectorAll('input')).some(secret)) return {ok:false,reason:'owner'};
  }
`;
// Preserve all existing observation/credential checks and operation semantics.
export const CURSOR_ACTION_FUNCTION = ACTION_FUNCTION.replace('function MATRIX_ACTION(', 'async function MATRIX_ACTION(')
  .replace("  if (action === 'inspect')", `${DRAW_CURSOR}\n  if (action === 'inspect')`);
