// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkRail } from '@desktop/renderer/src/features/work/WorkRail';
import type { CanonicalChatClient } from '@desktop/renderer/src/lib/canonical-chat-client';
import { clearChatNavigationScopes } from '@matrix-os/ui';
afterEach(() => { cleanup(); clearChatNavigationScopes(); });
it('uses one navigation snapshot across selection, never scans ordinary Bot IDs and opens canonical detail', async () => {
  const chat = { id: 'chat_one', title: 'Navigation one', titleVersion: 1, revision: 1, lifecycle: 'active' as const, attention: 'none' as const, messageCount: 0, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' };
  const full = { chat: { ...chat, ownerScope: { type: 'personal' as const, ownerId: 'owner_test' } } };
  const client = { navigation: vi.fn(async () => ({ version: 1, items: [{ chat, readState: { version: 0, unread: false, markedUnread: false, latestIncomingSeq: 0, readThroughSeq: 0 }, classification: { kind: 'ordinary' }, persistence: 'personal' }], truncated: false })), list: vi.fn(), getDetail: vi.fn(async () => ({ record: full, messages: [], runs: [], turns: [] })), agents: { list: vi.fn(async () => ({ enabled: true, agents: [] })), bots: { directChat: vi.fn(), directBot: vi.fn(), interactions: vi.fn() } } } as unknown as CanonicalChatClient;
  const select = vi.fn();
  const props = { client, projects: [], active: true, onNewGlobalChat: vi.fn(), onCreateProject: vi.fn(), onNewProjectChat: vi.fn(), onSelectChat: select, onCollapse: vi.fn() };
  const view = render(<WorkRail {...props}/>);
  await waitFor(() => expect(client.navigation).toHaveBeenCalledTimes(1));
  if (screen.getByRole('button', { name: 'Done' }).getAttribute('aria-expanded') === 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  const row = await screen.findByRole('button', { name: 'Navigation one' });
  fireEvent.click(row, { detail: 0 });
  await waitFor(() => expect(select).toHaveBeenCalledWith(full));
  view.rerender(<WorkRail {...props} activeChatId='chat_one'/>);
  view.rerender(<WorkRail {...props} activeProjectSlug='different'/>);
  expect(client.navigation).toHaveBeenCalledTimes(1);
  expect(client.list).not.toHaveBeenCalled();
  expect(client.agents!.bots!.directBot).not.toHaveBeenCalled();
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function selectionFixture({ initiallyFail = false, project = false } = {}) {
  const records = ['one', 'two'].map(key => ({ chat: { id: `chat_${key}`, title: `Selection ${key}`, titleVersion: 1, revision: 1, lifecycle: 'active' as const, attention: 'none' as const, messageCount: 0, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' } }));
  const details = records.map(record => ({ record: { chat: { ...record.chat, ownerScope: { type: 'personal' as const, ownerId: 'owner_test' } } }, messages: [], runs: [], turns: [] }));
  const pending = details.map(() => deferred<(typeof details)[number]>());
  const client = { navigation: vi.fn(async () => ({ version: 1, items: records.map(record => ({ ...record, readState: { version: 0, unread: false, markedUnread: false, latestIncomingSeq: 0, readThroughSeq: 0 }, classification: { kind: 'ordinary' }, persistence: 'personal' })), truncated: false })), getDetail: vi.fn((id: string) => pending[id === 'chat_one' ? 0 : 1]!.promise), agents: { list: vi.fn(async () => ({ enabled: true, agents: [] })), bots: { directChat: vi.fn(), directBot: vi.fn(), interactions: vi.fn() } } } as unknown as CanonicalChatClient;
  if (initiallyFail) vi.mocked(client.navigation!).mockRejectedValueOnce(new Error('temporary failure'));
  const select = vi.fn();
  const selectProject = vi.fn();
  const newChat = vi.fn();
  render(<WorkRail client={client} projects={project ? [{ slug: 'review', name: 'Review project', kind: 'scratch' }] : []} active onNewGlobalChat={newChat} onSelectProject={selectProject} onCreateProject={vi.fn()} onNewProjectChat={vi.fn()} onSelectChat={select} onCollapse={vi.fn()} />);
  await waitFor(() => expect(client.navigation).toHaveBeenCalledOnce());
  if (screen.getByRole('button', { name: 'Done' }).getAttribute('aria-expanded') === 'false') fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  if (!initiallyFail) await screen.findByRole('button', { name: 'Selection one' });
  return { pending, details, client, select, selectProject, newChat };
}
it('only opens the latest clicked Chat when detail responses resolve out of order', async () => {
  const x = await selectionFixture();
  fireEvent.click(screen.getByRole('button', { name: 'Selection one' }), { detail: 0 });
  fireEvent.click(screen.getByRole('button', { name: 'Selection two' }), { detail: 0 });
  await act(async () => { x.pending[1]!.resolve(x.details[1]!); });
  await waitFor(() => expect(x.select).toHaveBeenCalledWith(x.details[1]!.record));
  await act(async () => { x.pending[0]!.resolve(x.details[0]!); });
  expect(x.select).toHaveBeenCalledOnce();
});
it('does not reopen an earlier clicked Chat after starting a global draft', async () => {
  const x = await selectionFixture();
  fireEvent.click(screen.getByRole('button', { name: 'Selection one' }), { detail: 0 });
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await act(async () => { x.pending[0]!.resolve(x.details[0]!); });
  expect(x.newChat).toHaveBeenCalledOnce();
  expect(x.select).not.toHaveBeenCalled();
});
it('does not reopen an earlier clicked Chat after selecting a Project', async () => {
  const x = await selectionFixture({ project: true });
  fireEvent.click(screen.getByRole('button', { name: 'Selection one' }), { detail: 0 });
  fireEvent.click(screen.getByRole('button', { name: 'Review project' }));
  await act(async () => { x.pending[0]!.resolve(x.details[0]!); });
  expect(x.selectProject).toHaveBeenCalledOnce();
  expect(x.select).not.toHaveBeenCalled();
});
it('retries a transient failed navigation load through its visible Retry action', async () => {
  const x = await selectionFixture({ initiallyFail: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Retry loading chats' }));
  await screen.findByRole('button', { name: 'Selection one' });
  expect(x.client.navigation).toHaveBeenCalledTimes(2);
});
