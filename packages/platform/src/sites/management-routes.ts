import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { SiteAppSlugSchema, SiteRollbackSchema } from '@matrix-os/contracts';
import { RuntimeSlotSchema, SafeHandleSchema } from '../customer-vps-schema.js';
import { getRunningUserMachineByHandle, type PlatformDB } from '../db.js';
import { buildPlatformSyncVerificationToken, timingSafeTokenEquals } from '../platform-token.js';
import type { SitesService } from './service.js';
import { SiteError } from './types.js';
export function createSiteManagementRoutes(options: {
    db: PlatformDB;
    platformSecret: string;
    service: SitesService;
}): Hono {
    const app = new Hono();
    app.use('*', bodyLimit({ maxSize: 15 * 1024 * 1024, onError: c => c.json({ error: 'Site unavailable' }, 413) }));
    async function owner(c: Context) {
        if (options.platformSecret.length < 32)
            return null;
        const handle = SafeHandleSchema.safeParse(c.req.param('handle'));
        const appSlug = SiteAppSlugSchema.safeParse(c.req.param('appSlug'));
        const query = z.object({ runtimeSlot: RuntimeSlotSchema.default('primary') }).strict().safeParse(c.req.query());
        if (!handle.success || !appSlug.success || !query.success)
            throw new SiteError('invalid_request');
        const machine = await getRunningUserMachineByHandle(options.db, handle.data, query.data.runtimeSlot);
        // Reuse the already-provisioned machine/slot/epoch-bound sync credential.
        const authorization = c.req.header('authorization');
        const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
        if (!machine || machine.provisioningClass !== 'customer' || machine.accessClerkUserIds.length > 0 || !timingSafeTokenEquals(bearer, buildPlatformSyncVerificationToken({handle:machine.handle,machineId:machine.machineId,runtimeSlot:machine.runtimeSlot}, options.platformSecret,machine.runtimeTokenEpoch)))
            return null;
        return { ownerId: machine.clerkUserId, machineId: machine.machineId, appSlug: appSlug.data,
            authenticatedRuntime: { handle: machine.handle, runtimeSlot: machine.runtimeSlot, runtimeTokenEpoch: machine.runtimeTokenEpoch } };
    }
    app.onError((error, c) => {
        if (error instanceof SiteError)
            return c.json({ error: error.code === 'conflict' ? 'Site changed; reload and try again' : 'Site unavailable' }, error.code === 'conflict' ? 409 : error.code === 'not_found' ? 404 : error.code === 'invalid_request' ? 400 : 503);
        console.warn('[sites] management failed', error instanceof Error ? error.name : 'UnknownError');
        return c.json({ error: 'Site unavailable' }, 503);
    });
    app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
    const denied = (c: Context) => c.json({ error: 'Unauthorized' }, 401);
    app.get('/:appSlug', async (c) => { const identity = await owner(c); if (!identity)
        return denied(c); const site = await options.service.get(identity); if (!site)
        throw new SiteError('not_found'); return c.json(site); });
    app.post('/:appSlug', async (c) => { const identity = await owner(c); if (!identity)
        return denied(c); return c.json(await options.service.deploy(identity, await c.req.json().catch((error: unknown) => { if (error instanceof SyntaxError)
        return null; throw error; }))); });
    app.patch('/:appSlug', async (c) => { const identity = await owner(c); if (!identity)
        return denied(c); return c.json(await options.service.patch(identity, await c.req.json().catch((error: unknown) => { if (error instanceof SyntaxError)
        return null; throw error; }))); });
    app.delete('/:appSlug', async (c) => {
        const identity = await owner(c);
        if (!identity)
            return denied(c);
        const input = z.object({ baseRevision: z.number().int().min(0) }).strict().safeParse(await c.req.json().catch((error: unknown) => { if (error instanceof SyntaxError)
            return null; throw error; }));
        if (!input.success)
            throw new SiteError('invalid_request');
        return c.json(await options.service.unpublish(identity, input.data.baseRevision));
    });
    app.post('/:appSlug/rollback', async (c) => { const identity = await owner(c); if (!identity)
        return denied(c); const input = SiteRollbackSchema.safeParse(await c.req.json().catch((error: unknown) => { if (error instanceof SyntaxError)
        return null; throw error; })); if (!input.success)
        throw new SiteError('invalid_request'); return c.json(await options.service.rollback(identity, input.data.versionId, input.data.baseRevision)); });
    return app;
}
