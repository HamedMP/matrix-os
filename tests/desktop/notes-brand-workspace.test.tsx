// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { desktopPalette, fonts } from '@matrix-os/brand';
import NotesWorkspace from '../../desktop/src/renderer/src/features/notes/NotesWorkspace';
import { bundledDesktopIconForPath } from '../../desktop/src/renderer/src/features/desktop-shell/bundled-app-icons';
const { api } = vi.hoisted(() => ({ api: { post: vi.fn(), forRuntime: vi.fn() } }));
vi.mock('../../desktop/src/renderer/src/stores/connection', () => ({ useConnection: (select: (state: unknown) => unknown) => select({ api, runtimeSlot: 'preview', authGeneration: 1 }) }));
vi.mock('../../desktop/src/renderer/src/features/desktop-shell/OSWindow', () => ({ OSWindowSafeView: ({ children, area: _area, ...props }: React.ComponentProps<'div'> & { area: string }) => <div {...props}>{children}</div> }));
vi.mock('../../desktop/src/renderer/src/features/notes/NoteEditor', () => ({ default: () => <div aria-label="Note editor" /> }));
afterEach(cleanup);
it('uses the launcher artwork and Matrix typography while keeping note creation connected', async () => {
  api.forRuntime.mockReturnValue(api);
  api.post.mockImplementation(async (_path, body) => body.action === 'find' ? [] : {});
  const { container } = render(<NotesWorkspace active />);
  const create = await screen.findByRole('button', { name: 'Create a note' });
  await waitFor(() => expect(create.hasAttribute('disabled')).toBe(false));
  const icons = container.querySelectorAll('img[data-notes-artwork]');
  expect(icons.length).toBe(2);
  for (const icon of icons) expect(icon.getAttribute('src')).toBe(bundledDesktopIconForPath('apps/notes/index.html'));
  const workspace = container.querySelector<HTMLElement>('[data-slot="notes-workspace"]')!;
  expect(workspace.style.getPropertyValue('--notes-brand-teal')).toBe(desktopPalette.forest);
  expect(workspace.style.fontFamily).toBe(fonts.ui);
  expect(screen.getByRole('heading', { name: 'A little space for your thoughts' }).style.fontFamily).toBe(fonts.heading);
  fireEvent.click(create);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/bridge/query', expect.objectContaining({ app: 'notes', action: 'insert' })));
});
