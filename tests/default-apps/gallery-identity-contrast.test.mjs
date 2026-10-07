import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const css=await readFile(new URL('../../home/apps/_shared/gallery-family.css',import.meta.url),'utf8');
test('text accents follow host foreground when browser and Matrix themes differ',()=>{
 for(const selector of ['.key--op','.nav-item--active','.tab.active','.focus-presets button.active']) {
  assert.ok(css.includes(selector));
 }
 assert.match(css,/--app-text-accent:color-mix\(in srgb,var\(--app-fg\) 85%,var\(--identity-accent\)\)/);
 assert.match(css,/\.key--op[^{}]*\{ color:var\(--app-text-accent\); \}/);
});
test('Weather first-city action uses the matching accent foreground',()=>{
 assert.match(css,/\.primary-action[^{}]*\{ color:var\(--identity-on-accent\); \}/);
});
