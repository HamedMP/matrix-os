import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  resolveSubdomain,
  isPublicProfilePath,
  createDefaultProfile,
} from '../../packages/platform/src/profile-routing.js';

describe('platform/profile-routing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'profile-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveSubdomain', () => {
    it('extracts handle from subdomain', () => {
      expect(resolveSubdomain('hamed.matrix-os.com')).toBe('hamed');
    });

    it('returns null for main domain', () => {
      expect(resolveSubdomain('matrix-os.com')).toBeNull();
    });

    it('returns null for www subdomain', () => {
      expect(resolveSubdomain('www.matrix-os.com')).toBeNull();
    });

    it('returns null for api subdomain', () => {
      expect(resolveSubdomain('api.matrix-os.com')).toBeNull();
    });

    it('handles uppercase', () => {
      expect(resolveSubdomain('Hamed.Matrix-OS.com')).toBe('hamed');
    });

    it('returns null for non-matching hosts', () => {
      expect(resolveSubdomain('example.com')).toBeNull();
      expect(resolveSubdomain('localhost')).toBeNull();
    });
  });

  describe('isPublicProfilePath', () => {
    it('recognizes root as public', () => {
      expect(isPublicProfilePath('/')).toBe(true);
    });

    it('recognizes /profile as public', () => {
      expect(isPublicProfilePath('/profile')).toBe(true);
    });

    it('recognizes static assets as public', () => {
      expect(isPublicProfilePath('/profile/style.css')).toBe(true);
      expect(isPublicProfilePath('/profile/avatar.png')).toBe(true);
    });

    it('does not treat API paths as public profile', () => {
      expect(isPublicProfilePath('/api/message')).toBe(false);
    });

    it('does not treat ws paths as public profile', () => {
      expect(isPublicProfilePath('/ws')).toBe(false);
    });
  });

  describe('createDefaultProfile', () => {
    it('creates profile app directory with matrix.json', () => {
      const homePath = join(tmpDir, 'home');
      mkdirSync(join(homePath, 'apps'), { recursive: true });
      mkdirSync(join(homePath, 'system'), { recursive: true });
      writeFileSync(
        join(homePath, 'system', 'profile.md'),
        '---\nname: Hamed\nbio: Builder\n---\n',
      );

      createDefaultProfile(homePath, 'hamed');

      expect(existsSync(join(homePath, 'apps', 'profile', 'matrix.json'))).toBe(true);
      expect(existsSync(join(homePath, 'apps', 'profile', 'index.html'))).toBe(true);
    });

    it('does not overwrite existing profile', () => {
      const homePath = join(tmpDir, 'home');
      mkdirSync(join(homePath, 'apps', 'profile'), { recursive: true });
      writeFileSync(join(homePath, 'apps', 'profile', 'index.html'), 'custom');

      createDefaultProfile(homePath, 'hamed');

      const content = require('node:fs').readFileSync(
        join(homePath, 'apps', 'profile', 'index.html'),
        'utf-8',
      );
      expect(content).toBe('custom');
    });

    it('includes handle in generated profile', () => {
      const homePath = join(tmpDir, 'home');
      mkdirSync(join(homePath, 'apps'), { recursive: true });

      createDefaultProfile(homePath, 'alice');

      const html = require('node:fs').readFileSync(
        join(homePath, 'apps', 'profile', 'index.html'),
        'utf-8',
      );
      expect(html).toContain('alice');
    });
  });
});
