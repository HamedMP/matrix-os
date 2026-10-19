import { Hono } from 'hono';
import { describe, it, expect, vi } from 'vitest';
import { registerPreviewDeletionRoute } from '../../packages/platform/src/customer-vps-preview-deletion-routes.js';
it('requires operator auth and validates scope before asking for physical proof', async () => {
  const previewCleanupStatus = vi.fn().mockResolvedValue({ confirmed: false });
  const app = new Hono();
  registerPreviewDeletionRoute(app, { previewCleanupStatus } as any, c => c.req.header('authorization') === 'Bearer operator' ? null : c.json({ error: 'Unauthorized' }, 401));
  expect((await app.request('/preview-cleanup?pr=1&owner=user_team')).status).toBe(401);
  expect(previewCleanupStatus).not.toHaveBeenCalled();
  const headers = { authorization: 'Bearer operator' };
  expect((await app.request('/preview-cleanup?pr=0&owner=user_team', { headers })).status).toBe(400);
  const response = await app.request('/preview-cleanup?pr=1&owner=user_team', { headers });
  expect(await response.json()).toEqual({ confirmed: false });
  expect(previewCleanupStatus).toHaveBeenCalledWith({ pr: 1, owner: 'user_team' });
  previewCleanupStatus.mockRejectedValue(new Error('provider failure'));
  const failed = await app.request('/preview-cleanup?pr=1&owner=user_team', { headers });
  expect(failed.status).toBe(503);
  expect(JSON.stringify(await failed.json())).not.toContain('provider failure');
});
