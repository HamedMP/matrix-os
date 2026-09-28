import { Hono, type Context } from 'hono';
import { getActivePrivatePreviewMachineByHandle, isPrivatePreviewMachine } from './customer-vps-preview.js';
import { PRIVATE_PREVIEW_HANDLE_PATTERN } from './customer-vps-schema.js';
import type { PlatformDB } from './db.js';

const RELEASE_FILE_PATTERN = /^([A-Za-z0-9._-]{1,128})\.json$/;

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
    const handle = c.req.param('handle');
    const version = RELEASE_FILE_PATTERN.exec(c.req.param('releaseFile'))?.[1];
    if (!PRIVATE_PREVIEW_HANDLE_PATTERN.test(handle) || !version) return notFound(c);
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
