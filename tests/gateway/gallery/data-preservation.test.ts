import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  snapshotAppData,
  restoreAppData,
  type SnapshotResult,
  type RestoreResult,
} from '../../../packages/gateway/src/app-update.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    cp: vi.fn(),
    rm: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(),
  };
});

import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';

describe('gateway/data-preservation', () => {
  const homePath = '/tmp/test-home';
  const slug = 'test-app';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('snapshotAppData', () => {
    it('returns error when app data directory does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await snapshotAppData({
        homePath,
        slug,
        versionTag: '1.0.0',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('data directory');
    });

    it('creates snapshot of app data directory', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.cp).mockResolvedValue(undefined);

      const result = await snapshotAppData({
        homePath,
        slug,
        versionTag: '1.0.0',
      });

      expect(result.success).toBe(true);
      expect(result.snapshotPath).toContain('.snapshots');
      expect(result.snapshotPath).toContain(slug);
      expect(result.snapshotPath).toContain('1.0.0');
      expect(fsp.mkdir).toHaveBeenCalled();
      expect(fsp.cp).toHaveBeenCalledWith(
        expect.stringContaining(slug),
        expect.stringContaining('.snapshots'),
        { recursive: true }
      );
    });

    it('stores snapshot under ~/data/.snapshots/{slug}-{version}/', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.cp).mockResolvedValue(undefined);

      const result = await snapshotAppData({
        homePath,
        slug,
        versionTag: '2.5.0',
      });

      expect(result.success).toBe(true);
      expect(result.snapshotPath).toBe(
        `${homePath}/data/.snapshots/${slug}-2.5.0`
      );
    });
  });

  describe('restoreAppData', () => {
    it('returns error when snapshot does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await restoreAppData({
        homePath,
        slug,
        snapshotPath: '/tmp/snapshots/nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('snapshot');
    });

    it('restores data from snapshot to app data directory', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.cp).mockResolvedValue(undefined);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

      const result = await restoreAppData({
        homePath,
        slug,
        snapshotPath: `${homePath}/data/.snapshots/test-app-1.0.0`,
      });

      expect(result.success).toBe(true);
      expect(fsp.cp).toHaveBeenCalledWith(
        `${homePath}/data/.snapshots/test-app-1.0.0`,
        expect.stringContaining(slug),
        { recursive: true }
      );
    });

    it('clears existing app data before restoring', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      vi.mocked(fsp.cp).mockResolvedValue(undefined);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

      await restoreAppData({
        homePath,
        slug,
        snapshotPath: `${homePath}/data/.snapshots/test-app-1.0.0`,
      });

      expect(fsp.rm).toHaveBeenCalledWith(
        expect.stringContaining(slug),
        expect.objectContaining({ recursive: true, force: true })
      );
    });
  });

  describe('data preservation across version transitions', () => {
    it('snapshot then restore round-trip succeeds', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.cp).mockResolvedValue(undefined);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);

      const snapshot = await snapshotAppData({
        homePath,
        slug,
        versionTag: '1.0.0',
      });

      expect(snapshot.success).toBe(true);

      const restore = await restoreAppData({
        homePath,
        slug,
        snapshotPath: snapshot.snapshotPath!,
      });

      expect(restore.success).toBe(true);
    });
  });
});
