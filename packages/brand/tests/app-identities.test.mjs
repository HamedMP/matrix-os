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
 assert.doesNotMatch(css,/--(?:matrix-[\w-]+|success|warning|danger|destructive)\s*:/);
});

test('committed connected-app identity CSS is generated from the canonical palettes', async () => {
 const committed=await readFile(new URL('../../../home/app-templates/connected-starter/src/styles/app-identities.css',import.meta.url),'utf8');
 assert.equal(committed,renderAppIdentities(identities));
});

test('installed identities follow injected Matrix surfaces while gallery identities stay readable on light washes', () => {
 const css=renderAppIdentities(identities);
 const darkMedia=css.slice(css.indexOf('@media'));
 assert.doesNotMatch(darkMedia,/\.app-identity\[/,'gallery cards keep their light-surface palette');
 assert.ok(css.includes('rgb(from var(--matrix-bg, var(--identity-fallback-bg))'),'read the actual host theme rather than inventing an attribute');
 assert.ok(css.includes('@supports (color: rgb(from white calc(r + g * 0) g b))'),'older engines retain explicit media fallback');
 assert.ok(css.includes('--identity-fallback-bg:#ffffff'));
 assert.ok(css.includes('--identity-fallback-bg:#202338'));
 // Evaluate the generated RGB channel math against deliberately opposite device preferences.
 // Matrix injects --matrix-bg on :root and changes it with os:theme-update.
 for(const [id,palette] of Object.entries(identities)) {
  const selector=`.workbench[data-app="${id}"], :root:root:root[data-app="${id}"]`;
  const rule=css.slice(css.lastIndexOf(selector)).split('}')[0];
  const colors=[...rule.matchAll(/rgb\(from var\(--matrix-bg, var\(--identity-fallback-bg\)\) (.*?) \/ 1\)/g)].map(match=>match[1]);
  assert.equal(colors.length,2,id);
  const channels=hex=>hex.slice(1).match(/../g).map(value=>parseInt(value,16));
  for(const [bg,expectedAccent,expectedLabel] of [['#ffffff',palette.accent,'#ffffff'],['#202338',palette.darkAccent,'#202338']]) {
   const [r,g,b]=channels(bg);
   const evaluate=color=>[...color.matchAll(/calc\((\d+) \+ \((-?\d+)\) \* clamp\(0, 128 - r \* 0\.2126 - g \* 0\.7152 - b \* 0\.0722, 1\)\)/g)].map(match=>Number(match[1])+Number(match[2])*Math.min(1,Math.max(0,128-r*.2126-g*.7152-b*.0722)));
   assert.deepEqual(evaluate(colors[0]),channels(expectedAccent),`${id}: ${bg} Matrix background`);
   assert.deepEqual(evaluate(colors[1]),channels(expectedLabel),`${id}: ${bg} button labels`);
  }
 }
});

test('subject styles preserve app identities and unknown app ids preserve the host background', async () => {
 const studio=await readFile(new URL('../../../home/app-templates/connected-starter/src/styles/studio-layout.css',import.meta.url),'utf8');
 const subject=await readFile(new URL('../../../home/app-templates/connected-starter/src/styles/subject-views.css',import.meta.url),'utf8');
 const identityBackground=studio.slice(studio.indexOf('/* App identity'));
 assert.match(identityBackground,/var\(--identity-glow,var\(--bg\)\)/,'unlisted ids never invalidate the background declaration');
 const lastRule=(selector)=>subject.slice(subject.lastIndexOf(selector)).split('}')[0];
 assert.match(lastRule('.workbench[data-app="agenda"] .agenda-event'),/border-left-color:var\(--brand\)/);
 assert.match(lastRule('.workbench[data-app="focus"] .focus-stage'),/background:linear-gradient\(145deg,var\(--card\),var\(--tint\)\)/);
});
