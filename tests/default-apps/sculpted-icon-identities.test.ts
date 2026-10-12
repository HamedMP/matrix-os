import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const games = ['2048', 'backgammon', 'chess', 'minesweeper', 'snake', 'solitaire', 'tetris'];
describe('bundled game icon identities', () => {
  it.each(games)('%s declares its own semantic artwork', (slug) => {
    const manifest = JSON.parse(readFileSync(resolve('home/apps/games', slug, 'matrix.json'), 'utf8'));
    expect(manifest.icon).toBe(`v3-${slug}`);
    const asset = readFileSync(resolve('home/system/icons', `${manifest.icon}.png`));
    expect(asset.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
