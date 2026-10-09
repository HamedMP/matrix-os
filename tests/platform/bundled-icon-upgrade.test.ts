import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {smartSyncTemplate} from '../../packages/kernel/src/boot';

const root = process.cwd();
const script = join(root, 'distro/customer-vps/host-bin/matrix-sync-bundled-home-assets');
const legacyBytes = readFileSync(join(root, 'home/system/icons/game-center.png'));
const uniqueBytes = Buffer.from('new unique game artwork');
const temporaryRoots: string[] = [];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(() => { for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture({ tracked = true, currentStem = 'game-center', nextStem = 'chess', slug = 'chess', nestedGame = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'matrix-icon-upgrade-'));
  temporaryRoots.push(temp);
  const appDir = join(temp, 'app');
  const template = join(appDir, 'home');
  const home = join(temp, 'home');
  const relManifest = `apps/${nestedGame ? 'games/' : ''}${slug}/matrix.json`;
  const manifest = (icon: string, version: string) => JSON.stringify({
    name: slug, slug, author: 'system', listingTrust: 'first_party', icon, version,
  });
  const oldManifest = manifest(currentStem, '1.0.0');
  const newManifest = manifest(nextStem, '2.0.0');
  function write(base: string, path: string, bytes: string | Buffer) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), bytes);
  }
  const templateHashes: Record<string, string> = {
    [relManifest]: hash(newManifest),
    'system/icons/game-center.png': hash(legacyBytes),
    'system/icons/chess.png': hash(uniqueBytes),
  };
  write(template, relManifest, newManifest);
  write(template, 'system/icons/game-center.png', legacyBytes);
  write(template, 'system/icons/chess.png', uniqueBytes);
  write(home, relManifest, oldManifest);
  write(home, 'system/icons/game-center.png', legacyBytes);
  write(home, '.template-manifest.json', JSON.stringify(tracked ? { [relManifest]: hash(oldManifest) } : {}));
  const saveTemplate = () => write(template, '.template-manifest.json', JSON.stringify(templateHashes));
  saveTemplate();
  const sync = () => {
    const result = spawnSync(process.platform === 'darwin' ? '/bin/bash' : 'bash', [script], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, APP_DIR: appDir, MATRIX_HOME: home, MATRIX_NODE_BIN: process.execPath },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  };
  return { temp, template, home, relManifest, oldManifest, newManifest, templateHashes, saveTemplate, sync, write };
}

function expectSelection(f: ReturnType<typeof fixture>, expected: string) {
  f.sync();
  expect(readFileSync(join(f.home, f.relManifest), 'utf8')).toBe(expected);
  const manifestAfterFirstSync = readFileSync(join(f.home, '.template-manifest.json'), 'utf8');
  f.sync();
  expect(readFileSync(join(f.home, f.relManifest), 'utf8')).toBe(expected);
  expect(readFileSync(join(f.home, '.template-manifest.json'), 'utf8')).toBe(manifestAfterFirstSync);
}

describe('bundled icon upgrades preserve selected owner artwork', () => {
  it.each([true, false])('upgrades the actual nested game manifest with unchanged legacy artwork (tracked: %s)', (tracked) => {
    const f = fixture({ nestedGame: true, tracked });
    expect(f.relManifest).toBe('apps/games/chess/matrix.json');
    expectSelection(f, f.newManifest);
    expect(readFileSync(join(f.home, 'system/icons/game-center.png'))).toEqual(legacyBytes);
  });
  it('keeps selected customized artwork for the actual nested game manifest', () => {
    const f = fixture({ nestedGame: true });
    const custom = Buffer.from('owner customized game artwork');
    f.write(f.home, 'system/icons/game-center.png', custom);
    expectSelection(f, f.oldManifest);
    expect(readFileSync(join(f.home, 'system/icons/game-center.png'))).toEqual(custom);
  });
  it('keeps an unknown icon selection for the actual nested game manifest', () => {
    const f = fixture({ nestedGame: true, currentStem: 'owner-game' });
    const custom = 'owner icon without a bundled baseline';
    f.write(f.home, 'system/icons/owner-game.svg', custom);
    expectSelection(f, f.oldManifest);
    expect(readFileSync(join(f.home, 'system/icons/owner-game.svg'), 'utf8')).toBe(custom);
  });
  it.each(['{}', '{broken tracking'])('preserves differing untracked nested game code with tracking %s', (tracking) => {
    const f = fixture({ nestedGame: true, tracked: false });
    const source = 'apps/games/chess/src/App.tsx';
    f.write(f.template, source, 'new bundled source');
    f.templateHashes[source] = hash('new bundled source');
    f.saveTemplate();
    f.write(f.home, source, 'owner edited game');
    f.write(f.home, '.template-manifest.json', tracking);
    f.sync();
    expect(readFileSync(join(f.home, source), 'utf8')).toBe('owner edited game');
    expect(JSON.parse(readFileSync(join(f.home, '.template-manifest.json'), 'utf8'))[source]).toBeUndefined();
    f.sync();
    expect(readFileSync(join(f.home, source), 'utf8')).toBe('owner edited game');
  });
  it('updates tracked nested game code while preserving owner modifications', () => {
    const f = fixture({ nestedGame: true });
    const source = 'apps/games/chess/src/App.tsx';
    f.write(f.template, source, 'new bundled source');
    f.templateHashes[source] = hash('new bundled source');
    f.saveTemplate();
    f.write(f.home, source, 'old bundled source');
    f.write(f.home, '.template-manifest.json', JSON.stringify({ [source]: hash('old bundled source'), [f.relManifest]: hash(f.oldManifest) }));
    f.sync();
    expect(readFileSync(join(f.home, source), 'utf8')).toBe('new bundled source');
    f.write(f.home, source, 'owner edited game');
    f.sync();
    expect(readFileSync(join(f.home, source), 'utf8')).toBe('owner edited game');
  });
  it('never upgrades untracked game sources through a symlinked owner app directory', () => {
    const f = fixture({ nestedGame: true, tracked: false });
    const sourceRelPath = 'apps/games/chess/src/App.tsx';
    const bundledSource = 'new bundled game source';
    const outsideSource = 'owner project outside the bundled app directory';
    f.write(f.template, sourceRelPath, bundledSource);
    f.templateHashes[sourceRelPath] = hash(bundledSource);
    f.saveTemplate();
    const outside = join(f.temp, 'owner-project');
    f.write(outside, 'matrix.json', f.oldManifest);
    f.write(outside, 'src/App.tsx', outsideSource);
    const ownerGame = join(f.home, 'apps/games/chess');
    rmSync(ownerGame, { recursive: true });
    symlinkSync(outside, ownerGame);
    f.sync();
    expect(readFileSync(join(outside, 'src/App.tsx'), 'utf8')).toBe(outsideSource);
    expect(readFileSync(join(outside, 'matrix.json'), 'utf8')).toBe(f.oldManifest);
    expect(lstatSync(ownerGame).isSymbolicLink()).toBe(true);
    const firstManifest = readFileSync(join(f.home, '.template-manifest.json'), 'utf8');
    expect(JSON.parse(firstManifest)[sourceRelPath]).toBeUndefined();
    f.sync();
    expect(readFileSync(join(outside, 'src/App.tsx'), 'utf8')).toBe(outsideSource);
    expect(readFileSync(join(f.home, '.template-manifest.json'), 'utf8')).toBe(firstManifest);
  });
  it.each([true, false])('upgrades known default game artwork (tracked manifest: %s) without changing its bytes', (tracked) => {
    const f = fixture({ tracked });
    expectSelection(f, f.newManifest);
    expect(readFileSync(join(f.home, 'system/icons/game-center.png'))).toEqual(legacyBytes);
    expect(readFileSync(join(f.home, 'system/icons/chess.png'))).toEqual(uniqueBytes);
  });
  it.each([true, false])('retains a changed PNG selection even if the bundled SVG matches (tracked: %s)', (tracked) => {
    const f = fixture({ tracked });
    const custom = Buffer.from('owner drawing');
    f.write(f.home, 'system/icons/game-center.png', custom);
    f.write(f.home, 'system/icons/game-center.svg', '<svg>bundled</svg>');
    f.write(f.template, 'system/icons/game-center.svg', '<svg>bundled</svg>');
    f.templateHashes['system/icons/game-center.svg'] = hash('<svg>bundled</svg>');
    f.saveTemplate();
    expectSelection(f, f.oldManifest);
    expect(readFileSync(join(f.home, 'system/icons/game-center.png'))).toEqual(custom);
  });
  it('recognizes an unchanged SVG only when no PNG is selected', () => {
    const f = fixture();
    rmSync(join(f.home, 'system/icons/game-center.png'));
    rmSync(join(f.template, 'system/icons/game-center.png'));
    delete f.templateHashes['system/icons/game-center.png'];
    const svg = '<svg>bundled legacy game</svg>';
    f.write(f.home, 'system/icons/game-center.svg', svg);
    f.write(f.template, 'system/icons/game-center.svg', svg);
    f.templateHashes['system/icons/game-center.svg'] = hash(svg);
    f.saveTemplate();
    expectSelection(f, f.newManifest);
    expect(readFileSync(join(f.home, 'system/icons/game-center.svg'), 'utf8')).toBe(svg);
  });
  it('retains unknown legacy artwork when no bundled baseline exists', () => {
    const f = fixture({ currentStem: 'owner-game' });
    const custom = 'owner game icon';
    f.write(f.home, 'system/icons/owner-game.png', custom);
    expectSelection(f, f.oldManifest);
    expect(readFileSync(join(f.home, 'system/icons/owner-game.png'), 'utf8')).toBe(custom);
  });
  it('retains an icon symlink without reading or replacing its target', () => {
    const f = fixture();
    const target = join(f.temp, 'external.png');
    writeFileSync(target, legacyBytes);
    const icon = join(f.home, 'system/icons/game-center.png');
    rmSync(icon);
    symlinkSync(target, icon);
    expectSelection(f, f.oldManifest);
    expect(lstatSync(icon).isSymbolicLink()).toBe(true);
    expect(readFileSync(target)).toEqual(legacyBytes);
    expect(JSON.parse(readFileSync(join(f.home, '.template-manifest.json'), 'utf8'))['system/icons/game-center.png']).toBeUndefined();
  });
  it('does not hang when selected regular artwork is replaced by a FIFO just before open', () => {
    const f = fixture();
    const icon = join(f.home, 'system/icons/game-center.png');
    const preload = join(f.temp, 'swap-icon-at-open.cjs');
    writeFileSync(preload, `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const originalOpen = fs.openSync;
let swapped = false;
fs.openSync = function(path, flags, ...args) {
  if (!swapped && path === process.env.TEST_SELECTED_ICON && (flags & fs.constants.O_NOFOLLOW)) {
    swapped = true;
    fs.unlinkSync(path);
    const result = spawnSync('mkfifo', [path], { timeout: 1000, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('FIFO fixture could not be created');
  }
  return originalOpen.call(this, path, flags, ...args);
};
`);
    // Run the script's real Node body directly so timeout kills the blocked
    // process itself, without leaving a shell child waiting on the FIFO.
    const nodeSource = readFileSync(script, 'utf8').split("<<'NODE'\n")[1].replace(/\nNODE\s*$/, '');
    const result = spawnSync(process.execPath, ['-'], {
      cwd: root, encoding: 'utf8', timeout: 2000, input: nodeSource,
      env: {
        ...process.env, APP_DIR: join(f.temp, 'app'), MATRIX_HOME: f.home, MATRIX_NODE_BIN: process.execPath,
        TEST_SELECTED_ICON: icon, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`,
      },
    });
    expect(result.status, result.error?.message || result.stderr || result.stdout).toBe(0);
    expect(lstatSync(icon).isFIFO()).toBe(true);
    expect(readFileSync(join(f.home, f.relManifest), 'utf8')).toBe(f.oldManifest);
    expect(JSON.parse(readFileSync(join(f.home, '.template-manifest.json'), 'utf8'))['system/icons/game-center.png']).toBeUndefined();
  });
  it('does not traverse an owner icon directory symlink to classify or copy artwork', () => {
    const f = fixture();
    const target = join(f.temp, 'owner-icons');
    mkdirSync(target);
    writeFileSync(join(target, 'game-center.png'), legacyBytes);
    rmSync(join(f.home, 'system/icons'), { recursive: true });
    symlinkSync(target, join(f.home, 'system/icons'));
    expectSelection(f, f.oldManifest);
    expect(readFileSync(join(target, 'game-center.png'))).toEqual(legacyBytes);
    expect(existsSync(join(target, 'chess.png'))).toBe(false);
  });
  it.each(['../../outside', 'x'.repeat(65), ''])('retains an unclassifiable legacy icon stem %s', (currentStem) => {
    const f = fixture({ currentStem });
    expectSelection(f, f.oldManifest);
  });
  it('retains an oversized selected image conservatively', () => {
    const f = fixture();
    const custom = Buffer.alloc(4 * 1024 * 1024 + 1, 7);
    f.write(f.home, 'system/icons/game-center.png', custom);
    expectSelection(f, f.oldManifest);
    expect(readFileSync(join(f.home, 'system/icons/game-center.png'))).toEqual(custom);
  });
  it('still upgrades the manifest when its icon stem is unchanged', () => {
    const f = fixture({ nextStem: 'game-center' });
    f.write(f.home, 'system/icons/game-center.png', 'owner custom art');
    expectSelection(f, f.newManifest);
    expect(readFileSync(join(f.home, 'system/icons/game-center.png'), 'utf8')).toBe('owner custom art');
  });
  it.each(['app-gallery', 'resource-manager'])('ships versioned %s artwork while retaining its legacy filename', (slug) => {
    const manifest = JSON.parse(readFileSync(join(root, 'home/apps', slug, 'matrix.json'), 'utf8'));
    expect(manifest.icon).toBe(`v3-${slug}`);
    expect(existsSync(join(root, 'home/system/icons', `${manifest.icon}.png`))).toBe(true);
    expect(existsSync(join(root, 'home/system/icons', `${slug}.png`))).toBe(true);
    expect(existsSync(join(root, 'home/system/icons', `${slug}-v2.png`))).toBe(false);
  });
  it.each(['app-gallery', 'resource-manager'].flatMap(slug =>
    ['default', 'custom', 'unknown', 'symlink'].map(artwork => ({ slug, artwork })),
  ))('introduces $slug PNG only when selected legacy SVG is known default ($artwork)', ({ slug, artwork }) => {
    const f = fixture({ slug, currentStem: slug, nextStem: slug });
    const relSvg = `system/icons/${slug}.svg`;
    const relPng = `system/icons/${slug}.png`;
    const bundledSvg = readFileSync(join(root, 'home', relSvg));
    const sculptedPng = readFileSync(join(root, 'home', relPng));
    const selectedSvg = artwork === 'custom' || artwork === 'unknown' ? Buffer.from('owner selected SVG artwork') : bundledSvg;
    f.write(f.home, relSvg, selectedSvg);
    f.write(f.template, relPng, sculptedPng);
    f.templateHashes[relPng] = hash(sculptedPng);
    if (artwork !== 'unknown') {
      f.write(f.template, relSvg, bundledSvg);
      f.templateHashes[relSvg] = hash(bundledSvg);
    }
    if (artwork === 'symlink') {
      const target = join(f.temp, 'selected-owner.svg');
      writeFileSync(target, selectedSvg);
      rmSync(join(f.home, relSvg));
      symlinkSync(target, join(f.home, relSvg));
    }
    f.saveTemplate();
    expectSelection(f, f.newManifest);
    expect(readFileSync(join(f.home, relSvg))).toEqual(selectedSvg);
    if (artwork === 'default') {
      expect(readFileSync(join(f.home, relPng))).toEqual(sculptedPng);
    } else {
      expect(existsSync(join(f.home, relPng))).toBe(false);
      expect(JSON.parse(readFileSync(join(f.home, '.template-manifest.json'), 'utf8'))[relPng]).toBeUndefined();
      if (artwork === 'symlink') expect(lstatSync(join(f.home, relSvg)).isSymbolicLink()).toBe(true);
    }
  });
});

it('preserves selected owner artwork across host sync followed by kernel startup sync',()=>{
 const f=fixture({nestedGame:true});f.write(f.home,'system/icons/game-center.png','owner customized art');
 f.sync();smartSyncTemplate(f.home,f.template);
 expect(readFileSync(join(f.home,f.relManifest),'utf8')).toBe(f.oldManifest);
});
