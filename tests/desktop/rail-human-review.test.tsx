// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {WorkRailGroups} from '../../desktop/src/renderer/src/features/work/work-rail/WorkRailGroups';
import {buildWorkRailModel} from '../../desktop/src/renderer/src/features/work/work-rail-model';
afterEach(cleanup);
it.each([true, false])('keeps empty lifecycle headings visible without fabricated rows or counts (Done expanded: %s)',(done)=>{
  const toggle=vi.fn();
  render(<WorkRailGroups model={buildWorkRailModel([],[])} sections={{pinned:true,projects:true,needsYou:true,working:true,done}} onToggle={toggle} onCreateProject={vi.fn()} renderProject={()=>null} renderChat={()=>null} bots={[]} organizationDrives={null} sharedProjects={[]}/>);
  for(const label of ['Needs you','Working','Done']){
    const button=screen.getByRole('button',{name:label});
    expect(button.getAttribute('aria-expanded')).toBe(label === 'Done' ? String(done) : 'true');
    expect(within(button.closest('section')!).getAllByRole('button')).toHaveLength(1);
    expect(button.textContent).toBe(label);
    fireEvent.click(button);
  }
  expect(toggle.mock.calls).toEqual([['needsYou'],['working'],['done']]);
});
