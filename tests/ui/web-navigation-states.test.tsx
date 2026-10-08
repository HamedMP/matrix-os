// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {WebChatLifecycleGroups} from '../../shell/src/components/chat/WebChatLifecycleGroups';
afterEach(cleanup);
it('starts Done expanded, toggles by keyboard-accessible heading, and shows hidden count',()=>{
  const conversation={id:'completed',preview:'Finished chat',messageCount:1,updatedAt:1};
  render(<WebChatLifecycleGroups conversations={[conversation]} renderRow={item=><button>{item.preview}</button>}/>);
  const heading=screen.getByRole('button',{name:'Done'});
  expect(heading.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button',{name:'Finished chat'})).toBeTruthy();
  expect(screen.queryByLabelText('1 hidden chat')).toBeNull();
  fireEvent.click(heading);
  expect(heading.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button',{name:'Finished chat'})).toBeNull();
  expect(screen.getByLabelText('1 hidden chat').textContent).toBe('1');
  fireEvent.click(heading);
  expect(screen.getByRole('button',{name:'Finished chat'})).toBeTruthy();
  expect(screen.queryByLabelText('1 hidden chat')).toBeNull();
});

it('keeps the full Web title visible to assistive technology and exposes ellipsis actions', async()=>{
  const {RenameableConversationRow}=await import('../../shell/src/components/chat/ChatTitleRename');
  const title='Long descriptive Chat title '.repeat(5).trim();
  render(<RenameableConversationRow conversation={{id:'chat_fulltitle',title,preview:'',messageCount:1,updatedAt:1}} active mobile={false} editing={false} renamePending={false} onSelect={()=>{}} onRenameStart={()=>{}} onRenameCommit={()=>{}} onRenameCancel={()=>{}}/>);
  expect(screen.getByTitle(title).getAttribute('title')).toBe(title);
  const row=screen.getByRole('button',{name:title});
  expect(row.querySelector('svg')).toBeNull();
  expect(row.firstElementChild?.classList.contains('matrix-web-chat-title')).toBe(true);
  fireEvent.keyDown(screen.getByRole('button',{name:`Actions for ${title}`}),{key:'Enter'});
  expect(await screen.findByRole('menuitem',{name:'Rename'})).toBeTruthy();
});
