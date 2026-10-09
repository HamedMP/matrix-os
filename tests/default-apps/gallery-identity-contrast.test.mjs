import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const css=await readFile(new URL('../../home/apps/_shared/gallery-family.css',import.meta.url),'utf8');
const games=await readFile(new URL('../../home/apps/_shared/game-refresh.css',import.meta.url),'utf8');
const mines=await readFile(new URL('../../home/apps/games/minesweeper/src/App.tsx',import.meta.url),'utf8');
function declaration(selector, property) {
 const block=[...games.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^}]+)\}/g)]
  .find(match=>match[1].trim().split(',').map(value=>value.trim()).includes(selector))?.[2]??'';
 const value=block.match(new RegExp(`${property}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
 assert.ok(value, `${selector} needs a stable ${property} for fixed game ink`);
 return value;
}
function contrast(a,b) {
 const luminance=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255)
  .map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4)
  .reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
 const x=luminance(a),y=luminance(b);
 return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
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
test('face-up Solitaire ranks retain readable ink regardless of host theme',()=>{
 const face=declaration('.sol-app .sol-card--black', 'background');
 assert.ok(contrast('#1c1f1a',face)>=4.5);
 const redBlock=games.match(/\.sol-app \.sol-card--red \{ color:\s*(#[0-9a-f]{6})/i);
 assert.ok(redBlock);
 assert.ok(contrast(redBlock[1],face)>=4.5);
});
test('every Minesweeper number remains readable on revealed cells in dark mode',()=>{
 const face=declaration('.ms-root .ms-cell.is-open:not(.is-exploded)', 'background');
 const colors=[...mines.split('const NUMBER_COLORS')[1].split('};')[0].matchAll(/#[0-9a-f]{6}/gi)].map(m=>m[0]);
 assert.equal(colors.length,8);
 for(const ink of colors) assert.ok(contrast(ink,face)>=4.5, `${ink} on ${face}`);
});
test('Backgammon stack counts contrast with their fixed outline in either theme',()=>{
 const selector='.bg-app .chk-count';
 assert.ok(contrast(declaration(selector,'fill'),declaration(selector,'stroke'))>=4.5);
});
