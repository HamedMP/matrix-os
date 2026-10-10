import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
it.each(['wallet','notebook','book-open','briefcase','dumbbell','utensils'])('keeps the %s fallback as a small standalone vector',name=>{
 for(const dir of ['home/system/icons','home/apps/app-gallery/src/assets/icons']){
  const svg=readFileSync(resolve(dir,`${name}.svg`),'utf8');
  expect(svg).not.toContain('data:image');
  expect(Buffer.byteLength(svg)).toBeLessThan(2048);
  expect(svg).toContain('<svg');
 }
});

const appFallbacks = ['hiring', 'deliveries', 'follow-ups', 'projects', 'campaigns', 'support', 'pipeline', 'releases', 'meeting-briefs', 'agenda', 'company-spend', 'cashflow', 'folio', 'subscriptions', 'revenue', 'people', 'analytics', 'reading-library'];
it.each(['home/system/icons', 'home/apps/app-gallery/src/assets/icons'])('keeps app fallback identities distinct in %s', dir => {
 const glyphs = appFallbacks.map(name => {
  const svg = readFileSync(resolve(dir, `${name}.svg`), 'utf8');
  const glyph = svg.match(/<g\b[^>]*>([\s\S]*?)<\/g>/)?.[1];
  expect(glyph, `${name} must have a semantic vector glyph`).toBeTruthy();
  expect(Buffer.byteLength(svg)).toBeLessThan(2048);
  return glyph;
 });
 expect(new Set(glyphs).size).toBe(appFallbacks.length);
});
it.each(appFallbacks)('ships the same %s fallback identity in Gallery and the host', name => {
 expect(readFileSync(resolve('home/apps/app-gallery/src/assets/icons', `${name}.svg`), 'utf8')).toBe(readFileSync(resolve('home/system/icons', `${name}.svg`), 'utf8'));
});
