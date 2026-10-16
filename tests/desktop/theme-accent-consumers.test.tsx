// @vitest-environment jsdom
import React from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
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
  expect(contrastRatio(vars[icon.style.color.slice(4, -1)]!, vars[icon.style.background.slice(4, -1)]!)).toBeGreaterThanOrEqual(4.5);
  expect(vars[button.style.background.slice(4, -1)]).toBe('#413e3e');
  expect(contrastRatio(vars[button.style.color.slice(4, -1)]!, vars[button.style.background.slice(4, -1)]!)).toBeGreaterThanOrEqual(4.5);
});
