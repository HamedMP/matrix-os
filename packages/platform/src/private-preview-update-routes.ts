import { Hono, type Context } from 'hono';
import { z } from 'zod/v4';
import { getActivePrivatePreviewMachineByHandle, isPrivatePreviewMachine } from './customer-vps-preview.js';
import { PRIVATE_PREVIEW_HANDLE_PATTERN } from './customer-vps-schema.js';
import type { PlatformDB } from './db.js';

const ReleaseParamsSchema = z.object({
  handle: z.string().regex(PRIVATE_PREVIEW_HANDLE_PATTERN),
  version: z.string().regex(/^[A-Za-z0-9._-]{1,128}\.json$/).transform((file) => file.slice(0, -'.json'.length)),
});

function notFound(c: Context): Response {
  return c.json({ error: 'Not found' }, 404);
}

/**
 * Spec 537 per-machine update base. A Private Preview's host.env points its
 * updater at `/private-preview-updates/<handle>`. Only the release its owner
 * confirmed is served here; channel manifests, release lists, and every other
 * version return 404, so no updater can move the machine off that code.
 */
export function createPrivatePreviewUpdateRoutes(opts: {
  db: PlatformDB;
  /** The public host bundle routes; the confirmed release is served through them unchanged. */
  hostBundleRoutes: Hono;
  logRouteError: (route: string, err: unknown) => void;
}): Hono {
  const routes = new Hono();

  routes.get('/:handle/system-bundles/releases/:releaseFile', async (c) => {
    const params = ReleaseParamsSchema.safeParse({
      handle: c.req.param('handle'),
      version: c.req.param('releaseFile'),
    });
    if (!params.success) return notFound(c);
    const { handle, version } = params.data;
    try {
      const machine = await getActivePrivatePreviewMachineByHandle(opts.db, handle);
      if (!machine || !isPrivatePreviewMachine(machine) || machine.confirmedBundleVersion !== version) {
        return notFound(c);
      }
    } catch (err: unknown) {
      opts.logRouteError('/private-preview-updates/:handle/system-bundles/releases', err);
      return c.json({ error: 'Host bundle unavailable' }, 502);
    }
    return opts.hostBundleRoutes.request(`/releases/${version}.json`);
  });

  routes.all('*', notFound);
  return routes;
}
