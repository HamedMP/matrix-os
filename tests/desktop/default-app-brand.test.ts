import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { desktopPalette } from '@matrix-os/brand';
import { matrix } from '../../desktop/src/renderer/src/design/themes/matrix';
it('keeps the Matrix default app theme on the approved brand while retaining a real dark variant', () => {
  expect(matrix.light?.chrome.primary).toBe(desktopPalette.forest);
  expect(matrix.light?.chrome.background).toBe(desktopPalette.paper);
  expect(matrix.light?.chrome.foreground).toBe(desktopPalette.forest);
  expect(matrix.dark?.chrome.background).not.toBe(matrix.light?.chrome.background);
  const css = readFileSync('desktop/src/renderer/src/design/tokens.css', 'utf8');
  expect(css).toContain(`--brand-forest: ${desktopPalette.forest.toLowerCase()};`);
  expect(css).toContain('--font-ui: "Geist"');
  expect(css).toContain('--font-editorial: "Bricolage Grotesque"');
});

it('ships the exact native Notes artwork inside the rebuildable home app sources', () => {
  expect(readFileSync('home/apps/_shared/app-artwork/notes.png').equals(readFileSync('shell/public/system-app-icons/v2/notes.png'))).toBe(true);
});

it('invalidates Notes and Resource Manager when their shared brand or canonical artwork changes', () => {
  const notes = JSON.parse(readFileSync('home/apps/notes/matrix.json', 'utf8'));
  const resource = JSON.parse(readFileSync('home/apps/resource-manager/matrix.json', 'utf8'));
  expect(notes.build.sourceGlobs).toContain('../_shared/**');
  expect(resource.build.sourceGlobs).toContain('../../system/icons/v3-resource-manager.png');
});
