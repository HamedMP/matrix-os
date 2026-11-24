// @vitest-environment jsdom
import React from 'react';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {ChatContextMenu} from '../../packages/ui/src/chat/ChatContextMenu.js';
afterEach(cleanup);
it('opens the same supported actions from ellipsis and separates destructive actions', async()=>{
  const rename=vi.fn(), remove=vi.fn();
  render(<ChatContextMenu chatId="chat_row" dropdownTrigger={<button>Actions</button>} items={[{label:'Rename',onSelect:rename},{label:'Delete',danger:true,onSelect:remove}]}><button>Chat row</button></ChatContextMenu>);
  fireEvent.keyDown(screen.getByRole('button',{name:'Actions'}),{key:'Enter'});
  const menu=await screen.findByRole('menu');
  expect(screen.getByRole('separator')).toBeTruthy();
  expect(screen.getAllByRole('menuitem')).toEqual(['Rename','Copy chat ID','Delete'].map(name=>screen.getByRole('menuitem',{name,exact:true})));
  fireEvent.click(screen.getByRole('menuitem',{name:'Rename'}));
  expect(rename).toHaveBeenCalledOnce();expect(remove).not.toHaveBeenCalled();
  fireEvent.contextMenu(screen.getByRole('button',{name:'Chat row'}));
  expect(await screen.findByRole('menuitem',{name:'Delete'})).toBeTruthy();
});

it('reports right-click and dropdown visibility independently through open and Escape closure', async () => {
  const contextChanged = vi.fn(), dropdownChanged = vi.fn();
  render(<ChatContextMenu chatId="chat_row" onContextMenuOpenChange={contextChanged}
    onDropdownOpenChange={dropdownChanged} dropdownTrigger={<button>Actions</button>}>
    <button>Chat row</button>
  </ChatContextMenu>);
  fireEvent.contextMenu(screen.getByRole('button', {name: 'Chat row'}));
  await screen.findByRole('menu');
  expect(contextChanged).toHaveBeenLastCalledWith(true);
  expect(dropdownChanged).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('menu'), {key: 'Escape'});
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(contextChanged).toHaveBeenLastCalledWith(false);
  contextChanged.mockClear();
  fireEvent.keyDown(screen.getByRole('button', {name: 'Actions'}), {key: 'Enter'});
  await screen.findByRole('menu');
  expect(dropdownChanged).toHaveBeenLastCalledWith(true);
  expect(contextChanged).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('menu'), {key: 'Escape'});
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(dropdownChanged).toHaveBeenLastCalledWith(false);
  expect(contextChanged).not.toHaveBeenCalled();
});

it('highlights every menu item with the hover surface, not the accent fill', async () => {
  // Electron Desktop's --accent is its near-white primary fill, so focus:bg-accent hid the focused label.
  render(<ChatContextMenu chatId="chat_row" dropdownTrigger={<button>Actions</button>}
    primaryAction={{label: 'Mark as unread', onSelect: vi.fn()}}
    items={[{label: 'Move to project', children: [{label: 'kiki', onSelect: vi.fn()}]}, {label: 'Delete', danger: true, onSelect: vi.fn()}]}>
    <button>Chat row</button>
  </ChatContextMenu>);
  fireEvent.keyDown(screen.getByRole('button', {name: 'Actions'}), {key: 'Enter'});
  await screen.findByRole('menu');
  const items = screen.getAllByRole('menuitem');
  expect(items).toEqual([screen.getByRole('menuitem',{name:'Mark as unread',exact:true}),screen.getByRole('menuitem',{name:/^Move to project/}),screen.getByRole('menuitem',{name:'Copy chat ID',exact:true}),screen.getByRole('menuitem',{name:'Delete',exact:true})]);
  for (const item of items) {
    expect(item.className, item.textContent ?? '').toContain('focus:bg-[var(--bg-hover,var(--accent))]');
    expect(item.className, item.textContent ?? '').not.toMatch(/(?:^|\s)focus:bg-accent(?:\s|$)/);
  }
});
