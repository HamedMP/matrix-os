// Fixed functions execute in a dedicated isolated world. Page content and the
// model can supply data arguments, never JavaScript expressions or selectors.
const NAME_FUNCTION = `const nameOf = e => {
  const text = root => { let value = ''; const walk = doc.createTreeWalker(root,NodeFilter.SHOW_TEXT); let seen = 0;
    while (value.length < 512 && seen++ < 1000 && walk.nextNode()) { const parent = walk.currentNode.parentElement;
      if (parent && parent.getClientRects().length > 0 && getComputedStyle(parent).visibility !== 'hidden' && !parent.closest('input,textarea,select,script,style,[hidden],[aria-hidden="true"],[data-matrix-private]')) value += ' ' + (walk.currentNode.textContent || '').slice(0,512);
    } return value; };
  return (e.getAttribute('aria-label') || (e.labels && Array.from(e.labels).map(text).join(' ')) || (['INPUT','TEXTAREA','SELECT'].includes(e.tagName) ? '' : text(e))).replace(/\\s+/g,' ').trim().slice(0,180);
};`;

export const SNAPSHOT_FUNCTION = `function MATRIX_SNAPSHOT(observationId) {
  const doc = this;
  ${NAME_FUNCTION}
  const secret = e => e instanceof HTMLInputElement && (e.type === 'password' || e.autocomplete === 'one-time-code' || [e.name,e.id,e.placeholder,e.getAttribute('aria-label') || '',nameOf(e)].some(value => /password|passcode|secret.?key|one.?time|verification.?code|authentication.?code|security.?code|confirmation.?code|two.?factor|2fa|\\botp\\b|^code$/i.test(value)));
  const visible = e => e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden],[inert],[aria-hidden="true"],[data-matrix-private]');
  if (Array.from(doc.querySelectorAll('[data-matrix-owner-handoff]')).some(visible) || Array.from(doc.querySelectorAll('input')).some(e => visible(e) && secret(e))) { globalThis.__matrixBrowserObservation = null; return {handoff:true}; }
  const nodes = new Map(); const elements = [];
  for (const e of doc.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"]')) {
    if (elements.length >= 100) break;
    if (!visible(e) || secret(e) || e instanceof HTMLInputElement && ['hidden','file'].includes(e.type)) continue;
    const role = (e.getAttribute('role') || (e.tagName === 'A' ? 'link' : e.tagName === 'BUTTON' ? 'button' : e.tagName === 'SELECT' ? 'combobox' : 'textbox')).slice(0,40);
    const name = nameOf(e);
    const ref = 'r' + (elements.length + 1);
    nodes.set(ref,{element:e,role,name}); elements.push({ref,role,name});
  }
  let content = ''; let scanned = 0;
  const walk = doc.createTreeWalker(doc.body || doc.documentElement,NodeFilter.SHOW_TEXT);
  while (content.length < 16000 && scanned++ < 10000 && walk.nextNode()) {
    const node = walk.currentNode; const parent = node.parentElement;
    if (parent && visible(parent) && !parent.closest('input,textarea,select,script,style,noscript,[data-matrix-private]')) content += ' ' + (node.textContent || '').slice(0,1000);
  }
  globalThis.__matrixBrowserObservation = {id:observationId,document:doc,url:doc.URL,nodes};
  return {content:content.replace(/\\s+/g,' ').trim().slice(0,16000),title:(doc.title || '').slice(0,160),elements};
}`;

export const ACTION_FUNCTION = `function MATRIX_ACTION(observationId,ref,action,value) {
  const doc = this; const state = globalThis.__matrixBrowserObservation;
  ${NAME_FUNCTION}
  if (!state || state.id !== observationId || state.document !== doc || state.url !== doc.URL) return {ok:false,reason:'stale'};
  const secret = e => e instanceof HTMLInputElement && (e.type === 'password' || e.autocomplete === 'one-time-code' || [e.name,e.id,e.placeholder,e.getAttribute('aria-label') || '',nameOf(e)].some(value => /password|passcode|secret.?key|one.?time|verification.?code|authentication.?code|security.?code|confirmation.?code|two.?factor|2fa|\\botp\\b|^code$/i.test(value)));
  const visible = e => e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden],[inert],[aria-hidden="true"],[data-matrix-private]');
  if (Array.from(doc.querySelectorAll('[data-matrix-owner-handoff]')).some(visible) || Array.from(doc.querySelectorAll('input')).some(e => visible(e) && secret(e))) return {ok:false,reason:'owner'};
  const row = state.nodes.get(ref); const e = row && row.element;
  if (!e || !e.isConnected || e.ownerDocument !== doc || secret(e)) return {ok:false,reason:'stale'};
  if (!e.getClientRects().length || getComputedStyle(e).visibility === 'hidden' || e.closest('[hidden],[inert],[aria-hidden="true"],[data-matrix-private]') || e.disabled) return {ok:false,reason:action === 'wait' ? 'waiting' : 'stale'};
  const role = (e.getAttribute('role') || (e.tagName === 'A' ? 'link' : e.tagName === 'BUTTON' ? 'button' : e.tagName === 'SELECT' ? 'combobox' : 'textbox')).slice(0,40);
  const name = nameOf(e);
  if (role !== row.role || name !== row.name) return {ok:false,reason:'stale'};
  if (action === 'inspect') return {ok:true,href:e.tagName === 'A' ? e.href : null};
  if (action === 'click') { if (e.tagName === 'INPUT' && e.type === 'file') return {ok:false,reason:'unsupported'}; e.click(); }
  else if (action === 'type') {
    if (!(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) || e.readOnly || e instanceof HTMLInputElement && !['text','search','email','tel','url','number'].includes(e.type)) return {ok:false,reason:'unsupported'};
    e.focus(); const proto = e instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
  } else if (action === 'select') {
    if (!(e instanceof HTMLSelectElement) || !Array.from(e.options).some(o => o.value === value && !o.disabled)) return {ok:false,reason:'unsupported'};
    e.value = value; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
  } else if (action !== 'wait') return {ok:false,reason:'unsupported'};
  return {ok:true};
}`;
