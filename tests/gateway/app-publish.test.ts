import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  validateForPublish,
  generateSlug,
  preparePublishPayload,
} from '../../packages/gateway/src/app-publish.js';

describe('gateway/app-publish', () => {
  let tmpDir: string;
  let appsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'app-publish-'));
    appsDir = join(tmpDir, 'apps');
    mkdirSync(appsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('generateSlug', () => {
    it('converts name to URL-safe slug', () => {
      expect(generateSlug('Snake Game')).toBe('snake-game');
    });

    it('removes special characters', () => {
      expect(generateSlug('My App! (v2)')).toBe('my-app-v2');
    });

    it('trims leading/trailing hyphens', () => {
      expect(generateSlug('---Hello World---')).toBe('hello-world');
    });

    it('collapses multiple hyphens', () => {
      expect(generateSlug('foo    bar')).toBe('foo-bar');
    });
  });

  describe('validateForPublish', () => {
    it('validates a valid app directory', () => {
      const appDir = join(appsDir, 'snake');
      mkdirSync(appDir);
      writeFileSync(
        join(appDir, 'matrix.json'),
        JSON.stringify({ name: 'Snake Game', description: 'Classic snake', runtime: 'static' }),
      );
      writeFileSync(join(appDir, 'index.html'), '<html>snake</html>');

      const result = validateForPublish(appDir);
      expect(result.valid).toBe(true);
      expect(result.manifest).toBeDefined();
      expect(result.manifest!.name).toBe('Snake Game');
    });

    it('rejects app without matrix.json', () => {
      const appDir = join(appsDir, 'noManifest');
      mkdirSync(appDir);
      writeFileSync(join(appDir, 'index.html'), '<html></html>');

      const result = validateForPublish(appDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('manifest');
    });

    it('rejects app without name in manifest', () => {
      const appDir = join(appsDir, 'noName');
      mkdirSync(appDir);
      writeFileSync(join(appDir, 'matrix.json'), JSON.stringify({ runtime: 'static' }));

      const result = validateForPublish(appDir);
      expect(result.valid).toBe(false);
      // name is required by AppManifestSchema, so parsing fails -> no manifest found
      expect(result.error).toContain('manifest');
    });

    it('rejects app without description', () => {
      const appDir = join(appsDir, 'noDesc');
      mkdirSync(appDir);
      writeFileSync(join(appDir, 'matrix.json'), JSON.stringify({ name: 'Test' }));

      const result = validateForPublish(appDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('description');
    });

    it('rejects oversized apps', () => {
      const appDir = join(appsDir, 'big');
      mkdirSync(appDir);
      writeFileSync(
        join(appDir, 'matrix.json'),
        JSON.stringify({ name: 'Big', description: 'Too big' }),
      );
      // Create a file that exceeds the size limit (we'll test with a low limit)
      writeFileSync(join(appDir, 'large.bin'), Buffer.alloc(100));

      const result = validateForPublish(appDir, { maxSizeBytes: 50 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('size');
    });
  });

  describe('preparePublishPayload', () => {
    it('creates a publish payload from valid app', () => {
      const appDir = join(appsDir, 'chess');
      mkdirSync(appDir);
      writeFileSync(
        join(appDir, 'matrix.json'),
        JSON.stringify({
          name: 'Chess',
          description: 'Two-player chess',
          category: 'game',
          version: '1.0.0',
          author: '@hamed',
        }),
      );
      writeFileSync(join(appDir, 'index.html'), '<html>chess</html>');

      const payload = preparePublishPayload(appDir, '@hamed');
      expect(payload).toBeDefined();
      expect(payload!.name).toBe('Chess');
      expect(payload!.slug).toBe('chess');
      expect(payload!.authorId).toBe('@hamed');
      expect(payload!.category).toBe('game');
      expect(payload!.version).toBe('1.0.0');
      expect(payload!.description).toBe('Two-player chess');
      expect(payload!.manifest).toBeTruthy();
    });

    it('returns null for invalid app', () => {
      const appDir = join(appsDir, 'invalid');
      mkdirSync(appDir);

      const payload = preparePublishPayload(appDir, '@hamed');
      expect(payload).toBeNull();
    });

    it('generates slug from app name', () => {
      const appDir = join(appsDir, 'my-app');
      mkdirSync(appDir);
      writeFileSync(
        join(appDir, 'matrix.json'),
        JSON.stringify({ name: 'My Cool App', description: 'Cool' }),
      );

      const payload = preparePublishPayload(appDir, '@hamed');
      expect(payload!.slug).toBe('my-cool-app');
    });

    it('uses directory name as fallback slug', () => {
      const appDir = join(appsDir, 'cool-app');
      mkdirSync(appDir);
      writeFileSync(
        join(appDir, 'matrix.json'),
        JSON.stringify({ name: 'Cool App', description: 'Nice' }),
      );

      const payload = preparePublishPayload(appDir, '@alice');
      expect(payload!.slug).toBe('cool-app');
    });
  });
});
