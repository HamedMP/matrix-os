// @vitest-environment jsdom
import React from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { GitGraph } from '../../desktop/src/renderer/src/features/git/GitGraph';
import { resolvedStyleColor } from './theme-contrast-test-utils';
import { Button, IconButton } from '../../desktop/src/renderer/src/design/primitives';
import { getThemeVariant, contrastRatio } from '../../packages/brand/src/themes';
import { chromeToSemanticVars } from '../../packages/brand/src/themes/desktop-theme';

afterEach(cleanup);
it('keeps selected icons readable while primary buttons retain the selected fill', () => {
  render(<Tooltip.Provider><IconButton label="Selected action" active>+</IconButton><Button variant="primary">Run</Button></Tooltip.Provider>);
  const icon = screen.getByRole('button', { name: 'Selected action' });
  const button = screen.getByRole('button', { name: 'Run' });
  const chrome = getThemeVariant('custom', 'dark', { baseThemeId: 'matrix', dark: { accent: '#413e3e' }, light: {} }).chrome;
  const vars = chromeToSemanticVars(chrome);
  expect(contrastRatio(resolvedStyleColor(icon.style.color, vars), resolvedStyleColor(icon.style.background, vars))).toBeGreaterThanOrEqual(4.5);
  expect(resolvedStyleColor(button.style.background, vars)).toBe('#413e3e');
  expect(contrastRatio(resolvedStyleColor(button.style.color, vars), resolvedStyleColor(button.style.background, vars)!)).toBeGreaterThanOrEqual(4.5);
});

it('checks Load more text against its actual surface rather than a badge tint', () => {
  render(<GitGraph commits={[]} selectedSha={null} onSelect={() => {}} hasMore capped={false} loadingMore={false} onLoadMore={() => {}} />);
  const button = screen.getByRole('button', { name: 'Load more' });
  const chrome = getThemeVariant('custom', 'dark', { baseThemeId: 'matrix', dark: { surface: '#757575', accent: '#ffffff' }, light: {} }).chrome;
  const vars = chromeToSemanticVars(chrome);
  expect(contrastRatio(resolvedStyleColor(button.style.color, vars), resolvedStyleColor(button.parentElement!.style.background, vars))).toBeGreaterThanOrEqual(4.5);
});

it('rejects missing or misspelled colour lookups before calculating contrast', () => {
  for (const style of ['', 'red', 'var(--missing)']) expect(() => resolvedStyleColor(style, {})).toThrow();
});
