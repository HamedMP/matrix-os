import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
test('the composition uses the same catalog derivation as the storefront', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(source, /import\s+\{\s*visibleCatalog\s*\}\s+from\s+'\.\/gallery-model'/);
  assert.match(source, /visibleCatalog\(apps, collection, connected, ''\)/);
  assert.doesNotMatch(source, /apps\.filter\(/);
});
test('the picker overlay is fixed outside layout flow with bounded viewport scrolling', async () => {
  const css = await readFile(new URL('../src/WidgetsPreview.css', import.meta.url), 'utf8');
  assert.match(css, /\.widget-picker-backdrop\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.widget-picker\s*\{[^}]*max-height:\s*[^;]*dvh/);
  assert.match(css, /\.widget-picker\s*\{[^}]*overflow-y:\s*auto/);
});
