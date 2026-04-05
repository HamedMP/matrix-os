import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleInstall,
  handleUninstall,
  type GalleryInstallDeps,
} from '../../../packages/gateway/src/gallery-routes.js';

function createMockDeps(overrides: Partial<GalleryInstallDeps> = {}): GalleryInstallDeps {
  return {
    galleryDb: {
      selectFrom: vi.fn().mockReturnValue({
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({
              id: 'listing-1',
              slug: 'test-app',
              name: 'Test App',
              status: 'active',
              current_version_id: 'version-1',
            }),
          }),
        }),
      }),
    } as any,
    getListingById: vi.fn().mockResolvedValue({
      id: 'listing-1',
      slug: 'test-app',
      name: 'Test App',
      status: 'active',
      current_version_id: 'version-1',
    }),
    getVersionById: vi.fn().mockResolvedValue({
      id: 'version-1',
      listing_id: 'listing-1',
      version: '1.0.0',
      manifest: JSON.stringify({ name: 'Test App', permissions: ['fs.read'] }),
    }),
    getExistingInstall: vi.fn().mockResolvedValue(null),
    createInstallation: vi.fn().mockResolvedValue({
      id: 'install-1',
      listing_id: 'listing-1',
      version_id: 'version-1',
      user_id: 'user-1',
      status: 'active',
    }),
    incrementInstallCount: vi.fn().mockResolvedValue(undefined),
    deleteInstallation: vi.fn().mockResolvedValue(undefined),
    decrementInstallCount: vi.fn().mockResolvedValue(undefined),
    copyAppFiles: vi.fn().mockReturnValue({ success: true, targetDir: '/home/apps/test-app' }),
    removeAppFiles: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

describe('gallery/install-api', () => {
  describe('handleInstall', () => {
    it('installs an app successfully', async () => {
      const deps = createMockDeps();
      const result = await handleInstall(deps, {
        listingId: 'listing-1',
        userId: 'user-1',
        homePath: '/home',
        target: 'personal',
        approvedPermissions: ['fs.read'],
      });

      expect(result.status).toBe(201);
      expect(result.body.installationId).toBe('install-1');
      expect(result.body.slug).toBe('test-app');
      expect(deps.createInstallation).toHaveBeenCalled();
      expect(deps.incrementInstallCount).toHaveBeenCalledWith('listing-1');
      expect(deps.copyAppFiles).toHaveBeenCalled();
    });

    it('rejects when listing not found', async () => {
      const deps = createMockDeps({
        getListingById: vi.fn().mockResolvedValue(null),
      });

      const result = await handleInstall(deps, {
        listingId: 'no-such',
        userId: 'user-1',
        homePath: '/home',
        target: 'personal',
        approvedPermissions: [],
      });

      expect(result.status).toBe(404);
    });

    it('rejects when already installed', async () => {
      const deps = createMockDeps({
        getExistingInstall: vi.fn().mockResolvedValue({ id: 'existing' }),
      });

      const result = await handleInstall(deps, {
        listingId: 'listing-1',
        userId: 'user-1',
        homePath: '/home',
        target: 'personal',
        approvedPermissions: [],
      });

      expect(result.status).toBe(409);
    });

    it('rejects when listing is delisted', async () => {
      const deps = createMockDeps({
        getListingById: vi.fn().mockResolvedValue({
          id: 'listing-1',
          status: 'delisted',
          current_version_id: 'v1',
        }),
      });

      const result = await handleInstall(deps, {
        listingId: 'listing-1',
        userId: 'user-1',
        homePath: '/home',
        target: 'personal',
        approvedPermissions: [],
      });

      expect(result.status).toBe(400);
    });
  });

  describe('handleUninstall', () => {
    it('uninstalls successfully', async () => {
      const deps = createMockDeps({
        getExistingInstall: vi.fn().mockResolvedValue({
          id: 'install-1',
          listing_id: 'listing-1',
        }),
      });

      const result = await handleUninstall(deps, {
        slug: 'test-app',
        userId: 'user-1',
        homePath: '/home',
        installationId: 'install-1',
        preserveData: false,
      });

      expect(result.status).toBe(200);
      expect(deps.deleteInstallation).toHaveBeenCalledWith('install-1');
      expect(deps.decrementInstallCount).toHaveBeenCalledWith('listing-1');
    });
  });
});
