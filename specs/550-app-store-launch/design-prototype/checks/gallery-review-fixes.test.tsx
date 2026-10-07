import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('../src/DemoFrame', () => ({ default: ({ id }: { id: string }) => createElement('div', { 'data-testid': 'source-preview' }, id) }));
import { AppCard, Glyph, apps } from '../src/shared';
import { ConnectFlow } from '../src/Flow';
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', ''); } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); } });
afterEach(cleanup);
describe('complete gallery collection review', () => {
  it('uses the real source document for every legacy gallery card', () => {
    for (const app of apps) render(createElement(AppCard, { app, connected: [], onPick: vi.fn() }));
    expect(screen.getAllByTestId('source-preview').map(node => node.textContent)).toEqual(apps.map(app => app.id));
    expect(document.querySelector('img[src*="/previews/"]')).toBeNull();
  });
  it('gives all new workflow glyphs purpose-specific symbols', () => {
    const names = ['dumbbell', 'wallet', 'utensils', 'briefcase', 'book-open', 'notebook', 'chess', 'people', 'cashflow'];
    for (const name of names) render(createElement(Glyph, { name }));
    const symbols = [...document.querySelectorAll('svg')];
    expect(symbols).toHaveLength(names.length);
    expect(symbols.every(svg => !svg.classList.contains('lucide-grid-2x2'))).toBe(true);
    expect(new Set(symbols.map(svg => svg.getAttribute('class'))).size).toBe(names.length);
  });
  it('labels the Google Docs example account as Google Docs', () => {
    render(createElement(ConnectFlow, { connected: [], onConnected: vi.fn(), onClose: vi.fn() }));
    fireEvent.click(screen.getByRole('button', { name: /Google Docs.*Selected notes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try the example connection' }));
    expect(screen.getByText('Alex · Google Docs')).toBeTruthy();
    expect(screen.queryByText('Studio · Linear')).toBeNull();
  });
});
