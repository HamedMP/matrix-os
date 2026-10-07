import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderAppIdentities } from '../scripts/generate-app-identities.mjs';
const identities = JSON.parse(await readFile(new URL('../src/app-identities.json', import.meta.url)));
function luminance(hex) {
 const rgb = hex.slice(1).match(/../g).map(value => parseInt(value,16)/255).map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4);
 return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
}
function contrast(a,b) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
test('every reviewed app has its own accessible light and dark identity', () => {
 assert.equal(Object.keys(identities).length,26);
 assert.equal(new Set(Object.values(identities).map(value=>value.accent)).size,26);
 for (const [id,palette] of Object.entries(identities)) {
  for(const key of ['accent','darkAccent','wash','glow']) assert.match(palette[key],/^#[a-f0-9]{6}$/i,id);
  assert.ok(contrast(palette.accent,'#ffffff')>=4.5,`${id}: white button labels`);
  assert.ok(contrast(palette.darkAccent,'#202338')>=4.5,`${id}: dark button labels`);
  assert.ok(contrast(palette.accent,palette.wash)>=4.5,`${id}: labels on identity surfaces`);
 }
});
test('identity CSS works in installed apps and gallery surfaces without changing semantic status colors', () => {
 const css=renderAppIdentities(identities);
 for(const id of Object.keys(identities)) assert.ok(css.includes(`[data-app="${id}"]`));
 assert.ok(css.includes('.workbench[data-app='));
 assert.ok(css.includes('.app-identity[data-app='));
 assert.ok(css.includes(':root:root:root[data-app='));
 assert.ok(css.includes('prefers-color-scheme: dark'));
 assert.doesNotMatch(css,/--(?:matrix-|success|warning|danger|destructive)/);
});
