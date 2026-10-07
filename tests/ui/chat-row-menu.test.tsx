// @vitest-environment jsdom
import React from 'react';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {ChatContextMenu} from '../../packages/ui/src/chat/ChatContextMenu.js';
afterEach(cleanup);
it('opens the same supported actions from ellipsis and separates destructive actions', async()=>{
  const rename=vi.fn(), remove=vi.fn();
  render(<ChatContextMenu chatId="chat_row" dropdownTrigger={<button>Actions</button>} items={[{label:'Rename',onSelect:rename},{label:'Delete',danger:true,onSelect:remove}]}><button>Chat row</button></ChatContextMenu>);
  fireEvent.keyDown(screen.getByRole('button',{name:'Actions'}),{key:'Enter'});
  const menu=await screen.findByRole('menu');
  expect(screen.getByRole('separator')).toBeTruthy();
  expect(screen.getAllByRole('menuitem').map(item=>item.textContent)).toEqual(['Copy chat ID','Rename','Delete']);
  fireEvent.click(screen.getByRole('menuitem',{name:'Rename'}));
  expect(rename).toHaveBeenCalledOnce();expect(remove).not.toHaveBeenCalled();
  fireEvent.contextMenu(screen.getByRole('button',{name:'Chat row'}));
  expect(await screen.findByRole('menuitem',{name:'Delete'})).toBeTruthy();
});
