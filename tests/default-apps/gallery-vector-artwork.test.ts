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
