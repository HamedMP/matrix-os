import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
vi.mock('../src/DemoFrame', () => ({ default: ({ id }: { id: string }) => createElement('div', { 'data-testid': 'app-preview' }, id) }));
import GalleryShell from '../src/GalleryShell';
import WidgetsPreview from '../src/WidgetsPreview';
import Storefront from '../src/Storefront';
import ToolsPreview from '../src/ToolsPreview';
import { apps } from '../src/shared';
afterEach(cleanup);
const props = () => ({ apps, connected: ['gmail', 'google_calendar'] as const as unknown as ('gmail' | 'google_calendar')[], collection: 'all' as const, onCollection: vi.fn(), onConnect: vi.fn(), onPick: vi.fn() });
describe('gallery and widget preview interactions', () => {
  it('switches real panels with keyboard tab navigation and preserves the app collection', () => {
    render(createElement(GalleryShell, props()));
    expect(screen.getByRole('heading', { name: 'Matrix App Gallery' })).toBeTruthy();
    const galleryTab = screen.getByRole('tab', { name: 'Gallery' });
    fireEvent.keyDown(galleryTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Tools' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Tools that make your apps useful.' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Widgets' }));
    expect(screen.getByRole('heading', { name: 'A desktop with your kind of day.' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Gallery' }));
    expect(screen.getAllByTestId('app-preview')).toHaveLength(17);
  });
  it('adds, reorders and removes actual widget cards and retains hidden Work widgets', () => {
    render(createElement(WidgetsPreview));
    const board = screen.getByRole('list', { name: 'Example desktop widgets' });
    expect(within(board).getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Reading' }));
    expect(within(board).getAllByRole('listitem')).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Move Reading earlier' }));
    expect(within(board).getAllByRole('listitem').at(-2)?.getAttribute('data-widget')).toBe('reading');
    fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
    expect(within(board).getByText('Meeting preparation').closest('li')?.hidden).toBe(true);
    expect(within(board).getAllByRole('listitem').map(item => item.getAttribute('data-widget'))).not.toContain('agenda');
    fireEvent.click(screen.getByRole('button', { name: 'All widgets' }));
    expect(within(board).getAllByRole('listitem')).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Weather' }));
    expect(within(board).getAllByRole('listitem')).toHaveLength(6);
    expect(within(board).queryByText('A little brighter outside.')).toBeNull();
  });
  it('keeps an edited widget note when switching between Personal and Work', () => {
    render(createElement(WidgetsPreview));
    fireEvent.change(screen.getByLabelText('Example widget note'), { target: { value: 'Keep this thought while filtering.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
    expect(screen.queryByRole('textbox', { name: 'Example widget note' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    expect((screen.getByRole('textbox', { name: 'Example widget note' }) as HTMLTextAreaElement).value).toBe('Keep this thought while filtering.');
    fireEvent.click(screen.getByRole('button', { name: 'Reset example' }));
    expect((screen.getByLabelText('Example widget note') as HTMLTextAreaElement).value).toContain('Make something people want');
  });
  it('searches real packaged app candidates and keeps collection filtering owned by the parent', () => {
    const p = props();
    render(createElement(Storefront, p));
    fireEvent.change(screen.getByLabelText('Search apps'), { target: { value: 'trips' } });
    expect(screen.getAllByTestId('app-preview')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    expect(p.onCollection).toHaveBeenCalledWith('business');
    fireEvent.click(screen.getByRole('button', { name: 'Explore Atlas' }));
    expect(p.onPick).toHaveBeenCalledWith(apps.find(app => app.id === 'atlas'));
  });
  it('returns keyboard focus to Add widget after the picker closes', () => {
    render(createElement(WidgetsPreview));
    const add = screen.getByRole('button', { name: 'Add widget' });
    fireEvent.click(add);
    const reading = screen.getByRole('button', { name: 'Add Reading' });
    reading.focus();
    fireEvent.click(reading);
    expect(document.activeElement).toBe(add);
  });
  it('focuses the nearest visible card after removal, then Add widget when that view is empty', () => {
    render(createElement(WidgetsPreview));
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    const removeNote = screen.getByRole('button', { name: 'Remove Notes' });
    removeNote.focus();
    fireEvent.click(removeNote);
    const agenda = screen.getByRole('button', { name: 'Remove Agenda' }).closest('li');
    expect(document.activeElement).toBe(agenda);
    const removeAgenda = screen.getByRole('button', { name: 'Remove Agenda' });
    removeAgenda.focus();
    fireEvent.click(removeAgenda);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add widget' }));
  });
  it('focuses a moved widget when its move control reaches a disabled boundary', () => {
    render(createElement(WidgetsPreview));
    const earlier = screen.getByRole('button', { name: 'Move Agenda earlier' });
    const agenda = earlier.closest('li');
    earlier.focus();
    fireEvent.click(earlier);
    expect((screen.getByRole('button', { name: 'Move Agenda earlier' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(agenda);
  });
  it('opens a focused picker dialog and dismisses with Escape, close and outside clicks', () => {
    render(createElement(WidgetsPreview));
    const add = screen.getByRole('button', { name: 'Add widget' });
    for (const dismiss of ['escape', 'close', 'outside']) {
      add.focus(); fireEvent.click(add);
      const picker = screen.getByRole('dialog', { name: 'A little something useful' });
      expect(picker.contains(document.activeElement)).toBe(true);
      expect(document.body.style.overflow).toBe('hidden');
      if (dismiss === 'escape') fireEvent.keyDown(picker, { key: 'Escape' });
      else if (dismiss === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close widget picker' }));
      else fireEvent.click(picker.parentElement!);
      expect(screen.queryByRole('dialog', { name: 'A little something useful' })).toBeNull();
      expect(document.activeElement).toBe(add);
      expect(document.body.style.overflow).toBe('');
    }
  });
  it('keeps Tab focus inside the widget picker and leaves the widget board mounted', () => {
    render(createElement(WidgetsPreview));
    const board = screen.getByRole('list', { name: 'Example desktop widgets' });
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    const picker = screen.getByRole('dialog', { name: 'A little something useful' });
    const controls = within(picker).getAllByRole('button').filter(button => !(button as HTMLButtonElement).disabled);
    controls.at(-1)!.focus(); fireEvent.keyDown(picker, { key: 'Tab' });
    expect(document.activeElement).toBe(controls[0]);
    fireEvent.keyDown(picker, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(controls.at(-1));
    expect(screen.getByRole('list', { name: 'Example desktop widgets' })).toBe(board);
  });
  it('explains unmatched Tools and recovers to the real four-item list', () => {
    render(createElement(ToolsPreview, { connected: [], onConnect: vi.fn() }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Tools' }), { target: { value: 'unknown-tool' } });
    const empty = screen.getByRole('heading', { name: 'No Tools found.' }).parentElement!;
    expect(empty.querySelector('svg')).toBeTruthy();
    expect(within(empty).getByText(/Try another name/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all Tools' }));
    expect(screen.getByRole('heading', { name: 'Gmail' })).toBeTruthy();
  });
  it('explains an empty connected collection and starts the example connection flow', () => {
    const connect = vi.fn();
    render(createElement(ToolsPreview, { connected: [], onConnect: connect }));
    fireEvent.click(screen.getByRole('button', { name: 'Example connected' }));
    const empty = screen.getByRole('heading', { name: 'No example connections yet.' }).parentElement!;
    expect(empty.querySelector('svg')).toBeTruthy();
    expect(within(empty).getByText(/Connect an example Tool/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try an example connection' }));
    expect(connect).toHaveBeenCalledOnce();
  });
  it('gives an empty widget collection an icon and a working picker action', () => {
    render(createElement(WidgetsPreview));
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Agenda' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Notes' }));
    const empty = screen.getByRole('heading', { name: 'A clean slate.' }).parentElement!;
    expect(empty.querySelector('svg')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a widget' }));
    expect(screen.getByRole('dialog', { name: 'A little something useful' })).toBeTruthy();
  });
});
