import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handlePublish,
  handleResubmit,
  type GalleryPublishDeps,
} from '../../../packages/gateway/src/gallery-routes.js';

function createMockPublishDeps(overrides: Partial<GalleryPublishDeps> = {}): GalleryPublishDeps {
  return {
    galleryDb: {} as any,
    validateForPublish: vi.fn().mockReturnValue({
      valid: true,
      manifest: { name: 'My App', description: 'Great app', permissions: ['fs.read'] },
    }),
    createOrUpdateFromPublish: vi.fn().mockResolvedValue({
      id: 'listing-1',
      slug: 'my-app',
      name: 'My App',
      author_id: 'user-1',
    }),
    createVersion: vi.fn().mockResolvedValue({
      id: 'version-1',
      listing_id: 'listing-1',
      version: '1.0.0',
      audit_status: 'pending',
    }),
    runFullAudit: vi.fn().mockResolvedValue({
      id: 'audit-1',
      status: 'passed',
      manifestFindings: [],
      staticFindings: [],
      sandboxFindings: [],
    }),
    setCurrent: vi.fn().mockResolvedValue(undefined),
    readAppFiles: vi.fn().mockReturnValue(new Map([['index.js', 'export default 1;']])),
    ...overrides,
  };
}

describe('gallery/publish-api', () => {
  describe('handlePublish', () => {
    it('publishes an app successfully', async () => {
      const deps = createMockPublishDeps();
      const result = await handlePublish(deps, {
        appDir: '/home/apps/my-app',
        authorId: 'user-1',
        description: 'Great app',
        category: 'utility',
        version: '1.0.0',
        visibility: 'public',
      });

      expect(result.status).toBe(201);
      expect(result.body.listingId).toBe('listing-1');
      expect(result.body.versionId).toBe('version-1');
      expect(result.body.auditStatus).toBe('passed');
      expect(deps.setCurrent).toHaveBeenCalled();
    });

    it('returns findings when audit fails', async () => {
      const deps = createMockPublishDeps({
        runFullAudit: vi.fn().mockResolvedValue({
          id: 'audit-1',
          status: 'failed',
          manifestFindings: [{ rule: 'unknown-permission', severity: 'error', message: 'bad perm' }],
          staticFindings: [],
          sandboxFindings: [],
        }),
      });

      const result = await handlePublish(deps, {
        appDir: '/home/apps/my-app',
        authorId: 'user-1',
        description: 'Bad app',
        category: 'utility',
        version: '1.0.0',
        visibility: 'public',
      });

      expect(result.status).toBe(201);
      expect(result.body.auditStatus).toBe('failed');
      expect(result.body.auditFindings.length).toBeGreaterThan(0);
      expect(deps.setCurrent).not.toHaveBeenCalled();
    });

    it('rejects when manifest validation fails', async () => {
      const deps = createMockPublishDeps({
        validateForPublish: vi.fn().mockReturnValue({
          valid: false,
          error: 'No valid matrix.json manifest found',
        }),
      });

      const result = await handlePublish(deps, {
        appDir: '/home/apps/bad-app',
        authorId: 'user-1',
        description: 'Bad',
        category: 'utility',
        version: '1.0.0',
        visibility: 'public',
      });

      expect(result.status).toBe(400);
    });
  });

  describe('handleResubmit', () => {
    it('re-runs audit on a failed version', async () => {
      const deps = createMockPublishDeps({
        runFullAudit: vi.fn().mockResolvedValue({
          id: 'audit-2',
          status: 'passed',
          manifestFindings: [],
          staticFindings: [],
          sandboxFindings: [],
        }),
      });

      const result = await handleResubmit(deps, {
        versionId: 'version-1',
        appDir: '/home/apps/my-app',
        listingId: 'listing-1',
      });

      expect(result.status).toBe(200);
      expect(result.body.auditStatus).toBe('passed');
    });
  });
});
