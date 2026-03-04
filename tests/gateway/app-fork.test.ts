import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  forkApp,
  installApp,
} from '../../packages/gateway/src/app-fork.js';

describe('gateway/app-fork', () => {
  let tmpDir: string;
  let homePath: string;
  let sourceDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'app-fork-'));
    homePath = join(tmpDir, 'home');
    mkdirSync(join(homePath, 'apps'), { recursive: true });

    sourceDir = join(tmpDir, 'source');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, 'matrix.json'),
      JSON.stringify({ name: 'Chess', description: 'Two-player chess', runtime: 'static', category: 'game', version: '1.0.0' }),
    );
    writeFileSync(join(sourceDir, 'index.html'), '<html><body>Chess</body></html>');
    mkdirSync(join(sourceDir, 'assets'));
    writeFileSync(join(sourceDir, 'assets', 'style.css'), 'body { color: red; }');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('forkApp', () => {
    it('copies app files to user home', () => {
      const result = forkApp({
        sourceDir,
        homePath,
        slug: 'chess',
        author: '@hamed',
        version: '1.0.0',
      });

      expect(result.success).toBe(true);
      expect(result.targetDir).toBe(join(homePath, 'apps', 'chess'));
      expect(existsSync(join(homePath, 'apps', 'chess', 'index.html'))).toBe(true);
      expect(existsSync(join(homePath, 'apps', 'chess', 'assets', 'style.css'))).toBe(true);
    });

    it('adds forked_from metadata to matrix.json', () => {
      forkApp({
        sourceDir,
        homePath,
        slug: 'chess',
        author: '@hamed',
        version: '1.0.0',
      });

      const manifest = JSON.parse(readFileSync(join(homePath, 'apps', 'chess', 'matrix.json'), 'utf-8'));
      expect(manifest.forked_from).toEqual({
        author: '@hamed',
        slug: 'chess',
        version: '1.0.0',
      });
    });

    it('fails if target directory already exists', () => {
      mkdirSync(join(homePath, 'apps', 'chess'));
      writeFileSync(join(homePath, 'apps', 'chess', 'index.html'), 'existing');

      const result = forkApp({
        sourceDir,
        homePath,
        slug: 'chess',
        author: '@hamed',
        version: '1.0.0',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('fails if source directory does not exist', () => {
      const result = forkApp({
        sourceDir: join(tmpDir, 'nonexistent'),
        homePath,
        slug: 'nope',
        author: '@nobody',
        version: '1.0.0',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('installApp', () => {
    it('copies app files without forked_from metadata', () => {
      const result = installApp({
        sourceDir,
        homePath,
        slug: 'chess',
      });

      expect(result.success).toBe(true);
      const manifest = JSON.parse(readFileSync(join(homePath, 'apps', 'chess', 'matrix.json'), 'utf-8'));
      expect(manifest.forked_from).toBeUndefined();
      expect(manifest.installed_from).toBeTruthy();
    });

    it('copies all files including subdirectories', () => {
      installApp({ sourceDir, homePath, slug: 'chess' });

      expect(existsSync(join(homePath, 'apps', 'chess', 'index.html'))).toBe(true);
      expect(existsSync(join(homePath, 'apps', 'chess', 'assets', 'style.css'))).toBe(true);
    });
  });
});
