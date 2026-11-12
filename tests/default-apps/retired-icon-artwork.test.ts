import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import retired from '../fixtures/retired-icon-hashes.json';
import retiredClay from '../fixtures/retired-clay-icon-hashes.json';

describe('retired beige icon artwork', () => {
  it('is absent from shipped image assets, including duplicate copies', () => {
    const hashes = new Set([...Object.values(retired), ...Object.values(retiredClay)]);
    const paths = execFileSync('git', ['ls-files', '-z', '*.png', '*.webp', '*.jpg', '*.jpeg', '*.svg'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }).split('\0').filter(Boolean);
    const remaining = paths.filter(path => existsSync(path) && hashes.has(createHash('sha256').update(readFileSync(path)).digest('hex')));
    expect(remaining).toEqual([]);
  });
  it.each(Object.keys(retired))('removes the retired %s PNG path from the template', stem => {
    expect(existsSync(`home/system/icons/${stem}.png`)).toBe(false);
  });
  it('keeps retired paths out of the shipped template inventory', () => {
    const manifest = JSON.parse(readFileSync('home/.template-manifest.json', 'utf8'));
    for (const stem of Object.keys(retired)) expect(manifest[`system/icons/${stem}.png`]).toBeUndefined();
  });
  it.each(['notes', 'whiteboard', 'profile', 'social'])('selects shipped refreshed artwork for %s', slug => {
    const manifest = JSON.parse(readFileSync(`home/apps/${slug}/matrix.json`, 'utf8'));
    expect(manifest.icon).toBe(`v3-${slug}`);
    expect(existsSync(`home/system/icons/${manifest.icon}.png`)).toBe(true);
  });
});
