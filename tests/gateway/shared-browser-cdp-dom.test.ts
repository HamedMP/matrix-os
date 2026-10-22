// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SNAPSHOT_FUNCTION, ACTION_FUNCTION } from '../../packages/gateway/src/shared-browser/cdp-dom.js';

const snapshot = new Function(`return (${SNAPSHOT_FUNCTION});`)() as (this: Document, id: string) => any;
const action = new Function(`return (${ACTION_FUNCTION});`)() as (this: Document, id: string, ref: string, action: string, value: string | null) => any;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  document.body.innerHTML = '';
});
afterEach(() => { vi.restoreAllMocks(); delete (globalThis as any).__matrixBrowserObservation; });
it('yields a declared owner checkpoint without exposing or activating its controls',()=>{
  document.body.innerHTML='<section data-matrix-owner-handoff><button>Continue synthetic owner handoff</button></section>';
  expect(snapshot.call(document,'obs')).toEqual({handoff:true});
  expect(action.call(document,'obs','r1','click',null)).toMatchObject({ok:false});
});
it('excludes private nested labels and controls from both visible text and observation refs',()=>{
  document.body.innerHTML='<button><span data-matrix-private>hidden-original-credential</span>Download</button><div data-matrix-private><button>private-control</button></div>';
  const result=snapshot.call(document,'obs');expect(result.content).toBe('Download');
  expect(result.elements).toEqual([{ref:'r1',role:'button',name:'Download'}]);
  expect(JSON.stringify(result)).not.toMatch(/hidden-original-credential|private-control/);
});
it('never reads password, one-time-code, secret-key fields or surrounding credential-page content', () => {
  for (const attributes of ['type="password"', 'autocomplete="one-time-code"', 'name="otp"', 'id="secret-key"', 'aria-label="Verification code"']) {
    document.body.innerHTML = `<p>private account content</p><input ${attributes} value="private credential">`;
    Object.defineProperty(document.querySelector('input'), 'value', { get() { throw new Error('Credential value read'); } });
    expect(snapshot.call(document, 'obs')).toEqual({ handoff: true });
  }
});
it('ignores hidden credential checkpoints until they become visible', () => {
  document.body.innerHTML = '<p>Invoice list</p><div hidden data-matrix-owner-handoff><input type="password" value="private credential"></div><button>Collect</button>';
  const button = document.querySelector('button')!;
  const clicked = vi.fn(); button.addEventListener('click', clicked);
  const observed = snapshot.call(document, 'obs');
  expect(observed).toMatchObject({ content: 'Invoice list Collect', elements: [{ ref: 'r1', role: 'button', name: 'Collect' }] });
  expect(JSON.stringify(observed)).not.toContain('private credential');
  expect(action.call(document, 'obs', 'r1', 'click', null)).toEqual({ ok: true });
  expect(clicked).toHaveBeenCalledOnce();
  document.querySelector('div')!.hidden = false;
  expect(action.call(document, 'obs', 'r1', 'click', null)).toMatchObject({ ok: false, reason: 'owner' });
  expect(clicked).toHaveBeenCalledOnce();
});
it('returns visible content and grounded node refs without input values, hidden content or storage', () => {
  document.body.innerHTML = '<p>Invoice total EUR 90</p><p hidden>private hidden data</p><input aria-label="Invoice name" value="private input value"><textarea>private textarea value</textarea><button><span style="visibility:hidden">private hidden label</span>Collect invoice</button>';
  const result = snapshot.call(document, 'obs');
  expect(result.content).toBe('Invoice total EUR 90 Collect invoice');
  expect(result.elements).toContainEqual({ ref: 'r1', role: 'textbox', name: 'Invoice name' });
  expect(JSON.stringify(result)).not.toContain('private');
});
it('rejects secret-field mutation, replaced nodes, changed labels and stale observation IDs', () => {
  for (const changed of ['password', 'replace', 'label', 'observation']) {
    document.body.innerHTML = '<input aria-label="Invoice name"><button>Collect</button>';
    snapshot.call(document, 'obs');
    const input = document.querySelector('input')!;
    if (changed === 'password') input.type = 'password';
    if (changed === 'replace') input.outerHTML = '<input aria-label="Invoice name">';
    if (changed === 'label') input.setAttribute('aria-label', 'Other field');
    expect(action.call(document, changed === 'observation' ? 'old' : 'obs', 'r1', 'type', 'synthetic invoice')).toMatchObject({ ok: false });
    expect(document.querySelector('input')!.value).toBe('');
  }
});
it('types and selects only supported observed controls and emits their normal input/change events', () => {
  document.body.innerHTML = '<input aria-label="Invoice name"><select aria-label="Period"><option value="all">All</option><option value="quarter">Quarter</option></select>';
  const input = document.querySelector('input')!, select = document.querySelector('select')!;
  const changed = vi.fn(); input.addEventListener('input', changed); select.addEventListener('change', changed);
  snapshot.call(document, 'obs');
  expect(action.call(document, 'obs', 'r1', 'type', 'Invoice 001')).toEqual({ ok: true });
  expect(input.value).toBe('Invoice 001');
  expect(action.call(document, 'obs', 'r2', 'select', 'quarter')).toEqual({ ok: true });
  expect(select.value).toBe('quarter'); expect(changed).toHaveBeenCalledTimes(2);
});
it('caps references and text, excluding hidden controls', () => {
  document.body.innerHTML = '<p>' + 'visible '.repeat(5000) + '</p>' + '<button>Collect</button>'.repeat(150) + '<button hidden>Hidden</button>';
  const result = snapshot.call(document, 'obs');
  expect(result.elements).toHaveLength(100); expect(result.content.length).toBeLessThanOrEqual(16000);
});
it('distinguishes a temporarily hidden wait target from a stale or replaced node', () => {
  document.body.innerHTML = '<button>Collect</button>'; snapshot.call(document, 'obs');
  const button = document.querySelector('button')!; button.hidden = true;
  expect(action.call(document, 'obs', 'r1', 'wait', null)).toEqual({ ok: false, reason: 'waiting' });
  button.hidden = false;
  expect(action.call(document, 'obs', 'r1', 'wait', null)).toEqual({ ok: true });
  button.remove(); expect(action.call(document, 'obs', 'r1', 'wait', null)).toEqual({ ok: false, reason: 'stale' });
});
