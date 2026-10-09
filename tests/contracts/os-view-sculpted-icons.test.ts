import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { osViewBundledIconUrlForPath, osViewIconUrlForApp } from '../../packages/contracts/src/os-view';

describe('bundled Matrix app artwork', () => {
  it.each([
    'https://app.matrix-os.com/vm/pr-2294',
    'https://app.matrix-os.com/vm/pr-2294/~runtime/review/',
  ])('binds missing selections to the explicit runtime %s', (bundledAssetBaseUrl) => {
    const base = bundledAssetBaseUrl.replace(/\/$/, '');
    for (const [path, slug] of [['__create-app__', 'create-app'], ['__terminal__', 'terminal'], ['apps/notes/index.html', 'notes']]) {
      expect(osViewIconUrlForApp({ path }, bundledAssetBaseUrl)).toBe(`${base}/system-app-icons/v2/${slug}.png`);
    }
    expect(osViewIconUrlForApp({ path: 'apps/custom/index.html' }, bundledAssetBaseUrl)).toBeUndefined();
  });
  it.each(['/icons/owner.png', 'https://owner.example/art.png?revision=2', 'data:image/png;base64,owner'])('preserves selected owner URL %s verbatim with a runtime base', (iconUrl) => {
    expect(osViewIconUrlForApp({ path: '__terminal__', iconUrl }, 'https://app.matrix-os.com/vm/pr-2294')).toBe(iconUrl);
  });
  it.each(['notes', 'whiteboard'])('replaces the legacy %s icon URL with bundled artwork', (slug) => {
    expect(osViewIconUrlForApp({ path: `apps/${slug}/index.html`, iconUrl: `/icons/${slug}.png?v=legacy` }, 'https://runtime.example.com'))
      .toBe(`https://runtime.example.com/system-app-icons/v2/${slug}.png`);
    expect(osViewIconUrlForApp({ path: `apps/${slug}/index.html`, iconUrl: `/icons/owner-${slug}.png?v=selected` }, 'https://runtime.example.com'))
      .toBe(`/icons/owner-${slug}.png?v=selected`);
  });
  it('uses the same identity across launchers while preserving owner artwork and third-party logos', () => {
    expect(osViewIconUrlForApp({ path: '__terminal__', iconUrl: '/icons/terminal.svg' })).toBe('/icons/terminal.svg');
    expect(osViewIconUrlForApp({ path: 'apps/notes/index.html', iconUrl: '/icons/my-notes.png' })).toBe('/icons/my-notes.png');
    expect(osViewIconUrlForApp({ path: 'apps/whiteboard/dist/index.html', iconUrl: '/icons/my-drawing.png' })).toBe('/icons/my-drawing.png');
    expect(osViewIconUrlForApp({ path: '__vscode__', iconUrl: '/icons/vscode.svg' })).toBe('/icons/vscode.svg');
    expect(osViewIconUrlForApp({ path: 'apps/custom/index.html', iconUrl: '/icons/custom.png' })).toBe('/icons/custom.png');
    expect(osViewIconUrlForApp({ path: '__notes__' })).toBe('/system-app-icons/v2/notes.png');
  });
  it.each(['__terminal__', '__browser__', 'apps/browser/index.html', '__settings__'])('honors explicit owner artwork for %s and uses bundled artwork only when missing', (path) => {
    expect(osViewIconUrlForApp({ path, iconUrl: '/icons/owner-selection.png' })).toBe('/icons/owner-selection.png');
    expect(osViewIconUrlForApp({ path })).toBe(osViewBundledIconUrlForPath(path));
  });
  it.each([
    ['__create-app__','create-app'], ['__os-view-canvas__','canvas'], ['__os-view-desktop__','desktop'],
    ['__chat__','chat'], ['__terminal__','terminal'], ['__file-browser__','files'],
    ['__editor__','editor'], ['__settings__','settings'], ['__plugins__','plugins'], ['__browser__','browser'],
    ['apps/notes/index.html','notes'], ['apps/whiteboard/index.html','whiteboard'],
  ])('%s resolves a shipped sculpted asset', (path, slug) => {
    const url = osViewBundledIconUrlForPath(path);
    expect(url).toBe(`/system-app-icons/v2/${slug}.png`);
    expect(existsSync(resolve('shell/public', url!.slice(1)))).toBe(true);
  });
  it('keeps third-party branding and unknown app identities out of the override', () => {
    expect(osViewBundledIconUrlForPath('__vscode__')).toBeUndefined();
    expect(osViewBundledIconUrlForPath('apps/custom/index.html')).toBeUndefined();
    expect(osViewBundledIconUrlForPath('__settings__/../../secret')).toBeUndefined();
  });
  it('reconciles canonical aliases without inspecting names', () => {
    expect(osViewBundledIconUrlForPath('apps/browser/dist/index.html')).toBe('/system-app-icons/v2/browser.png');
    expect(osViewBundledIconUrlForPath('__notes__')).toBe('/system-app-icons/v2/notes.png');
  });
});
