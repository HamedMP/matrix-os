import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyUpdate,
  rollbackUpdate,
  type UpdateResult,
  type RollbackResult,
} from '../../../packages/gateway/src/app-update.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    copyFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    cp: vi.fn(),
    rm: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
  };
});

import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';

describe('gateway/app-update', () => {
  const homePath = '/tmp/test-home';
  const slug = 'test-app';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('applyUpdate', () => {
    it('returns error when app is not installed', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await applyUpdate({
        homePath,
        slug,
        newVersionBundlePath: '/tmp/bundles/test-app-v2',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    });

    it('returns error when new version bundle not found', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const path = String(p);
        if (path.includes('/apps/test-app')) return true;
        if (path.includes('/bundles/')) return false;
        return false;
      });

      const result = await applyUpdate({
        homePath,
        slug,
        newVersionBundlePath: '/tmp/bundles/test-app-v2',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('bundle not found');
    });

    it('copies new version files over existing app directory', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fsp.cp).mockResolvedValue(undefined);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

      const result = await applyUpdate({
        homePath,
        slug,
        newVersionBundlePath: '/tmp/bundles/test-app-v2',
      });

      expect(result.success).toBe(true);
      expect(fsp.cp).toHaveBeenCalled();
    });
  });

  describe('rollbackUpdate', () => {
    it('returns error when app is not installed', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await rollbackUpdate({
        homePath,
        slug,
        previousVersionBundlePath: '/tmp/bundles/test-app-v1',
        snapshotPath: '/tmp/snapshots/test-app-v1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    });

    it('returns error when previous version bundle not found', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const path = String(p);
        if (path.includes('/apps/test-app')) return true;
        if (path.includes('/bundles/')) return false;
        return true;
      });

      const result = await rollbackUpdate({
        homePath,
        slug,
        previousVersionBundlePath: '/tmp/bundles/test-app-v1',
        snapshotPath: '/tmp/snapshots/test-app-v1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('bundle not found');
    });

    it('restores previous version files and data snapshot', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fsp.cp).mockResolvedValue(undefined);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

      const result = await rollbackUpdate({
        homePath,
        slug,
        previousVersionBundlePath: '/tmp/bundles/test-app-v1',
        snapshotPath: '/tmp/snapshots/test-app-v1',
      });

      expect(result.success).toBe(true);
      expect(result.dataRestored).toBe(true);
      expect(fsp.cp).toHaveBeenCalled();
    });

    it('succeeds without data restore when no snapshot exists', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const path = String(p);
        if (path.includes('/snapshots/')) return false;
        return true;
      });
      vi.mocked(fsp.cp).mockResolvedValue(undefined);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

      const result = await rollbackUpdate({
        homePath,
        slug,
        previousVersionBundlePath: '/tmp/bundles/test-app-v1',
        snapshotPath: '/tmp/snapshots/nonexistent',
      });

      expect(result.success).toBe(true);
      expect(result.dataRestored).toBe(false);
    });
  });
});
