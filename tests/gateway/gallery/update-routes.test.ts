import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleUpdate,
  handleRollback,
  type GalleryUpdateDeps,
} from '../../../packages/gateway/src/gallery-routes.js';

function createMockDeps(overrides: Partial<GalleryUpdateDeps> = {}): GalleryUpdateDeps {
  return {
    galleryDb: {} as any,
    getInstallation: vi.fn().mockResolvedValue(null),
    getListingById: vi.fn().mockResolvedValue(null),
    getVersionById: vi.fn().mockResolvedValue(null),
    markInstallationUpdated: vi.fn().mockResolvedValue(undefined),
    getPreviousVersion: vi.fn().mockResolvedValue(null),
    applyUpdate: vi.fn().mockResolvedValue({ success: true }),
    rollbackUpdate: vi.fn().mockResolvedValue({ success: true, dataRestored: false }),
    snapshotAppData: vi.fn().mockResolvedValue({ success: true, snapshotPath: '/tmp/snap' }),
    ...overrides,
  };
}

const defaultInput = {
  slug: 'test-app',
  userId: 'user-1',
  homePath: '/tmp/home',
  listingId: 'listing-1',
};

describe('handleUpdate', () => {
  it('returns 404 when app is not installed', async () => {
    const deps = createMockDeps();
    const result = await handleUpdate(deps, defaultInput);
    expect(result.status).toBe(404);
    expect(result.body.error).toMatch(/not installed/i);
  });

  it('returns 404 when listing not found', async () => {
    const deps = createMockDeps({
      getInstallation: vi.fn().mockResolvedValue({ id: 'inst-1', version_id: 'v1' }),
    });
    const result = await handleUpdate(deps, defaultInput);
    expect(result.status).toBe(404);
    expect(result.body.error).toMatch(/not found/i);
  });

  it('returns 400 when already on latest version', async () => {
    const deps = createMockDeps({
      getInstallation: vi.fn().mockResolvedValue({ id: 'inst-1', version_id: 'v1' }),
      getListingById: vi.fn().mockResolvedValue({ id: 'listing-1', current_version_id: 'v1' }),
    });
    const result = await handleUpdate(deps, defaultInput);
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/already on the latest/i);
  });

  it('returns 400 when new version bundle not available', async () => {
    const deps = createMockDeps({
      getInstallation: vi.fn().mockResolvedValue({ id: 'inst-1', version_id: 'v1' }),
      getListingById: vi.fn().mockResolvedValue({ id: 'listing-1', current_version_id: 'v2' }),
      getVersionById: vi.fn().mockResolvedValue({ id: 'v2', version: '2.0.0', bundle_path: null }),
    });
    const result = await handleUpdate(deps, defaultInput);
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/bundle not available/i);
  });

  it('snapshots data, applies update, and updates installation', async () => {
    const markUpdated = vi.fn().mockResolvedValue(undefined);
    const applyUpdateMock = vi.fn().mockResolvedValue({ success: true });
    const snapshotMock = vi.fn().mockResolvedValue({ success: true, snapshotPath: '/snap' });

    const deps = createMockDeps({
      getInstallation: vi.fn().mockResolvedValue({ id: 'inst-1', version_id: 'v1' }),
      getListingById: vi.fn().mockResolvedValue({ id: 'listing-1', current_version_id: 'v2' }),
      getVersionById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'v1') return { id: 'v1', version: '1.0.0', bundle_path: '/bundles/v1' };
        if (id === 'v2') return { id: 'v2', version: '2.0.0', bundle_path: '/bundles/v2', changelog: 'New features' };
        return null;
      }),
      markInstallationUpdated: markUpdated,
      applyUpdate: applyUpdateMock,
      snapshotAppData: snapshotMock,
    });

    const result = await handleUpdate(deps, defaultInput);

    expect(result.status).toBe(200);
    expect(result.body.updated).toBe(true);
    expect(result.body.previousVersion).toBe('1.0.0');
    expect(result.body.newVersion).toBe('2.0.0');
    expect(result.body.changelog).toBe('New features');
    expect(snapshotMock).toHaveBeenCalledWith({
      homePath: '/tmp/home',
      slug: 'test-app',
      versionTag: '1.0.0',
    });
    expect(applyUpdateMock).toHaveBeenCalledWith({
      homePath: '/tmp/home',
      slug: 'test-app',
      newVersionBundlePath: '/bundles/v2',
    });
    expect(markUpdated).toHaveBeenCalledWith('inst-1', 'v2');
  });

  it('returns 500 when applyUpdate fails', async () => {
    const deps = createMockDeps({
      getInstallation: vi.fn().mockResolvedValue({ id: 'inst-1', version_id: 'v1' }),
      getListingById: vi.fn().mockResolvedValue({ id: 'listing-1', current_version_id: 'v2' }),
      getVersionById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'v1') return { id: 'v1', version: '1.0.0', bundle_path: '/b/v1' };
        return { id: 'v2', version: '2.0.0', bundle_path: '/b/v2' };
      }),
      applyUpdate: vi.fn().mockResolvedValue({ success: false, error: 'Disk full' }),
    });

    const result = await handleUpdate(deps, defaultInput);
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('Disk full');
  });
});

describe('handleRollback', () => {
  it('returns 404 when app is not installed', async () => {
    const deps = createMockDeps();
    const result = await handleRollback(deps, defaultInput);
    expect(result.status).toBe(404);
    expect(result.body.error).toMatch(/not installed/i);
  });

  it('returns 400 when no previous version exists', async () => {
    const deps = createMockDeps({
      getInstallation: vi.fn().mockResolvedValue({ id: 'inst-1', version_id: 'v2' }),
      getPreviousVersion: vi.fn().mockResolvedValue(null),
    });
    const result = await handleRollback(deps, defaultInput);
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/no previous version/i);
  });

  it('returns 400 when previous version bundle not available', async () => {
    const deps = createMockDeps({
      getInstallation: vi.fn().mockResolvedValue({ id: 'inst-1', version_id: 'v2' }),
      getPreviousVersion: vi.fn().mockResolvedValue({ id: 'v1', version: '1.0.0', changelog: null }),
      getVersionById: vi.fn().mockResolvedValue({ id: 'v1', version: '1.0.0', bundle_path: null }),
    });
    const result = await handleRollback(deps, defaultInput);
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/bundle not available/i);
  });

  it('rolls back to previous version and updates installation', async () => {
    const markUpdated = vi.fn().mockResolvedValue(undefined);
    const rollbackMock = vi.fn().mockResolvedValue({ success: true, dataRestored: true });

    const deps = createMockDeps({
      getInstallation: vi.fn().mockResolvedValue({ id: 'inst-1', version_id: 'v2' }),
      getPreviousVersion: vi.fn().mockResolvedValue({ id: 'v1', version: '1.0.0', changelog: null }),
      getVersionById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'v1') return { id: 'v1', version: '1.0.0', bundle_path: '/bundles/v1' };
        return { id: 'v2', version: '2.0.0', bundle_path: '/bundles/v2' };
      }),
      markInstallationUpdated: markUpdated,
      rollbackUpdate: rollbackMock,
    });

    const result = await handleRollback(deps, defaultInput);

    expect(result.status).toBe(200);
    expect(result.body.rolledBack).toBe(true);
    expect(result.body.restoredVersion).toBe('1.0.0');
    expect(result.body.dataRestored).toBe(true);
    expect(rollbackMock).toHaveBeenCalled();
    expect(markUpdated).toHaveBeenCalledWith('inst-1', 'v1');
  });

  it('returns 500 when rollbackUpdate fails', async () => {
    const deps = createMockDeps({
      getInstallation: vi.fn().mockResolvedValue({ id: 'inst-1', version_id: 'v2' }),
      getPreviousVersion: vi.fn().mockResolvedValue({ id: 'v1', version: '1.0.0', changelog: null }),
      getVersionById: vi.fn().mockResolvedValue({ id: 'v1', version: '1.0.0', bundle_path: '/b/v1' }),
      rollbackUpdate: vi.fn().mockResolvedValue({ success: false, dataRestored: false, error: 'Permission denied' }),
    });

    const result = await handleRollback(deps, defaultInput);
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('Permission denied');
  });
});
