// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CURSOR_ACTION_FUNCTION, CLEAR_CURSOR_FUNCTION } from '../../packages/gateway/src/shared-browser/cdp-cursor.js';
import { SNAPSHOT_FUNCTION } from '../../packages/gateway/src/shared-browser/cdp-dom.js';
const snapshot=new Function(`return (${SNAPSHOT_FUNCTION})`)();
const action=new Function(`return (${CURSOR_ACTION_FUNCTION})`)();
const clear=new Function(`return (${CLEAR_CURSOR_FUNCTION})`)();
beforeEach(()=>{vi.useFakeTimers();document.body.innerHTML='<button>Collect</button>';
  vi.spyOn(HTMLElement.prototype,'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:100,top:120,width:40,height:20} as DOMRect);
  snapshot.call(document,'obs');
});
afterEach(()=>{clear.call(document);vi.useRealTimers();vi.restoreAllMocks();delete (globalThis as any).__matrixBrowserObservation;});
it('shows a noninteractive private pointer and click pulse before the grounded click',async()=>{
  let atClick:HTMLElement|null=null;const button=document.querySelector('button')!;const clicked=vi.fn(()=>{atClick=document.querySelector('[data-matrix-agent-cursor]');});button.addEventListener('click',clicked);
  const pending=action.call(document,'obs','r1','click',null);await vi.advanceTimersByTimeAsync(120);expect(await pending).toEqual({ok:true});expect(clicked).toHaveBeenCalledOnce();
  {
    const cursor=document.querySelector('[data-matrix-agent-cursor]') as HTMLElement;
    expect(cursor).not.toBeNull();expect(cursor.style.left).toBe('120px');expect(cursor.style.top).toBe('130px');
    expect(cursor.style.pointerEvents).toBe('none');expect(cursor.getAttribute('aria-hidden')).toBe('true');
    expect(cursor.getAttribute('data-matrix-private')).toBe('');expect(cursor.getAttribute('data-click')).toBe('true');
  }
  expect(atClick).not.toBeNull();
  expect(snapshot.call(document,'next').elements).toHaveLength(1);
  expect(snapshot.call(document,'another').content).toBe('Collect');
});
it('removes the decorative layer and timer on explicit clear and bounded expiry',async()=>{
  const interrupted=action.call(document,'obs','r1','click',null);expect(vi.getTimerCount()).toBeGreaterThan(0);
  expect(clear.call(document)).toEqual({ok:true});expect(document.querySelector('[data-matrix-agent-cursor]')).toBeNull();expect(vi.getTimerCount()).toBe(0);expect(await interrupted).toMatchObject({ok:false});
  const expired=action.call(document,'obs','r1','click',null);await vi.advanceTimersByTimeAsync(5000);await expired;expect(document.querySelector('[data-matrix-agent-cursor]')).toBeNull();
});
it('does not draw or act for stale observations or non-finite target coordinates',async()=>{
  expect(await action.call(document,'old','r1','click',null)).toMatchObject({ok:false});expect(document.querySelector('[data-matrix-agent-cursor]')).toBeNull();
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({left:NaN,top:0,width:40,height:20} as DOMRect);
  const clicked=vi.fn();document.querySelector('button')!.addEventListener('click',clicked);
  expect(await action.call(document,'obs','r1','click',null)).toMatchObject({ok:false});expect(clicked).not.toHaveBeenCalled();
});

it('clearing while painting cancels the pending click without activating the page',async()=>{
  const clicked=vi.fn();document.querySelector('button')!.addEventListener('click',clicked);
  const pending=action.call(document,'obs','r1','click',null);clear.call(document);
  expect(await pending).toMatchObject({ok:false});expect(clicked).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

it('rechecks owner authentication and target state after the paint delay',async()=>{
  document.body.innerHTML='<input aria-label="Invoice name">';snapshot.call(document,'obs');
  const input=document.querySelector('input')!;const clicked=vi.fn();input.addEventListener('click',clicked);
  const pending=action.call(document,'obs','r1','click',null);input.type='password';
  await vi.advanceTimersByTimeAsync(120);expect(await pending).toMatchObject({ok:false});expect(clicked).not.toHaveBeenCalled();
});
