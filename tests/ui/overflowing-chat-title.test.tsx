// @vitest-environment jsdom
import React from 'react';
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {OverflowingChatTitle} from '../../desktop/src/renderer/src/features/work/OverflowingChatTitle';
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('measures only the reserved title viewport and remeasures after rename and resize',()=>{
  let width=100;
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(()=>width);
  vi.spyOn(HTMLElement.prototype,'scrollWidth','get').mockImplementation(function(this: HTMLElement){return (this.textContent?.length??0)*8;});
  let resized!: ()=>void;
  const disconnect=vi.fn();
  vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){resized=callback;}observe(){}disconnect(){disconnect();}});
  const title='A'.repeat(30);
  const view=render(<OverflowingChatTitle title={title}/>);
  const viewport=screen.getByTitle(title).parentElement!;
  expect(viewport.getAttribute('data-overflowing')).toBe('true');
  expect(viewport.style.getPropertyValue('--chat-title-scroll-distance')).toBe('140px');
  view.rerender(<OverflowingChatTitle title="Short"/>);
  expect(screen.getByTitle('Short').parentElement!.getAttribute('data-overflowing')).toBe('false');
  width=20;
  React.act(()=>resized());
  expect(screen.getByTitle('Short').parentElement!.style.getPropertyValue('--chat-title-scroll-distance')).toBe('20px');
  view.unmount();expect(disconnect).toHaveBeenCalled();
});

it('remeasures a fitting quiet title when revealed actions reduce its viewport', () => {
 let width = 100;
 vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
 vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => 96);
 let resized!: () => void;
 vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
 render(<OverflowingChatTitle title="Fits quietly"/>);
 const viewport = screen.getByTitle('Fits quietly').parentElement!;
 expect(viewport.getAttribute('data-overflowing')).toBe('false');
 width = 50; React.act(() => resized());
 expect(viewport.getAttribute('data-overflowing')).toBe('true');
 expect(viewport.style.getPropertyValue('--chat-title-scroll-distance')).toBe('46px');
 width = 100; React.act(() => resized());
 expect(viewport.getAttribute('data-overflowing')).toBe('false');
});
