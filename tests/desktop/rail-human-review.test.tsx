// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {WorkRailGroups} from '../../desktop/src/renderer/src/features/work/work-rail/WorkRailGroups';
import {buildWorkRailModel} from '../../desktop/src/renderer/src/features/work/work-rail-model';
import type { CanonicalChatRecord } from '@matrix-os/contracts';
afterEach(cleanup);
it.each([true, false])('keeps empty lifecycle headings visible without fabricated rows or counts (Done expanded: %s)',(done)=>{
  const toggle=vi.fn();
  render(<WorkRailGroups model={buildWorkRailModel([],[])} sections={{pinned:true,projects:true,needsYou:true,failed:true,working:true,done}} onToggle={toggle} onCreateProject={vi.fn()} renderProject={()=>null} renderChat={()=>null} bots={[]} organizationDrives={null} sharedProjects={[]}/>);
  for(const label of ['Needs you','Failed','Working','Done']){
    const button=screen.getByRole('button',{name:label});
    expect(button.getAttribute('aria-expanded')).toBe(label === 'Done' ? String(done) : 'true');
    expect(within(button.closest('section')!).getAllByRole('button')).toHaveLength(1);
    expect(button.textContent).toBe(label);
    fireEvent.click(button);
  }
  expect(toggle.mock.calls).toEqual([['needsYou'],['failed'],['working'],['done']]);
});
it('shows a failed chat only in Failed, with a distinct count', () => {
  const record = {chat:{id:'failed-chat',title:'Failed chat',attention:'failed',userState:{pinned:false}}} as CanonicalChatRecord;
  const model = buildWorkRailModel([record], []);
  render(<WorkRailGroups model={model} sections={{pinned:true,projects:true,needsYou:true,failed:true,working:true,done:true}} onToggle={vi.fn()} onCreateProject={vi.fn()} renderProject={()=>null} renderChat={item=><button key={item.chat.id}>{item.chat.title}</button>} bots={[]} organizationDrives={null} sharedProjects={[]}/>);
  const failed = screen.getByRole('button',{name:'Failed'}).closest('section')!;
  expect(within(failed).getByRole('button',{name:'Failed chat'})).toBeTruthy();
  expect(within(failed).getByLabelText('1 failed chat')).toBeTruthy();
  expect(within(screen.getByRole('button',{name:'Needs you'}).closest('section')!).queryByRole('button',{name:'Failed chat'})).toBeNull();
});
