import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { SITE_MANAGEMENT_CONTRACT_VERSION, SITE_MANAGEMENT_CONTRACT_VERSION_HEADER,
    SITE_PUBLISH_TIMEOUT_MS, SiteAccessLinkCreateRequestSchema, SiteAccessLinksQuerySchema,
    SiteAppSlugSchema, SiteIdSchema, SiteRollbackSchema, type SiteAccessLinksResponse, type SiteRecord,
    SiteEmailInvitationCreateRequestSchema, SiteEmailInvitationListQuerySchema, SiteEmailInvitationMutationRequestSchema,
    SiteInvitationAuditCursorSchema } from '@matrix-os/contracts';
import { RuntimeSlotSchema, SafeHandleSchema } from '../customer-vps-schema.js';
import { getRunningUserMachineByHandle, type PlatformDB } from '../db.js';
import { buildPlatformSyncVerificationToken, timingSafeTokenEquals } from '../platform-token.js';
import type { SitesService } from './service.js';
import { SiteError } from './types.js';
import { createSiteEmailInvitations, listSiteEmailInvitations, resendSiteEmailInvitation,
    revokeSiteEmailInvitation } from './email-invitations.js';
import { listSiteInvitationAuditEvents } from './invitation-audit.js';
export function createSiteManagementRoutes(options: {
    db: PlatformDB;
    platformSecret: string;
    service: SitesService;
    emailEnabled?: () => Promise<boolean>;
}): Hono {
    const app = new Hono();
    app.use('*', bodyLimit({ maxSize: 15 * 1024 * 1024, onError: c => c.json({ error: 'Site unavailable' }, 413) }));
    async function owner(c: Context, paging = false) {
        if (options.platformSecret.length < 32)
            return null;
        const handle = SafeHandleSchema.safeParse(c.req.param('handle'));
        const appSlug = SiteAppSlugSchema.safeParse(c.req.param('appSlug'));
        const query = z.object({
            runtimeSlot: RuntimeSlotSchema.default('primary'),
            ...(paging ? { limit: z.string().regex(/^\d{1,3}$/).optional(), cursor: z.string().max(256).optional() } : {}),
        }).strict().safeParse(c.req.query());
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
    const smallBody = bodyLimit({ maxSize: 2048, onError: c => c.json({ error: 'Site unavailable' }, 413) });
    const usesCurrentContract = (c: Context) => c.req.header(SITE_MANAGEMENT_CONTRACT_VERSION_HEADER) === SITE_MANAGEMENT_CONTRACT_VERSION;
    const usesAccessModeContract = (c: Context) => c.req.header(SITE_MANAGEMENT_CONTRACT_VERSION_HEADER) === '2' || usesCurrentContract(c);
    const rejectUnnegotiatedAccessMode = (c: Context, input: unknown) => {
        if (!usesAccessModeContract(c) && typeof input === 'object' && input !== null && Object.hasOwn(input, 'accessMode'))
            throw new SiteError('invalid_request');
    };
    const siteResponse = (c: Context, site: SiteRecord) => {
        if (usesCurrentContract(c))
            return c.json(site);
        const { capabilities: _, ...withoutEmail } = site;
        if (usesAccessModeContract(c))
            return c.json(withoutEmail);
        const { accessMode: __, ...legacySite } = withoutEmail;
        return c.json(legacySite);
    };
    const accessLinksResponse = (c: Context, result: SiteAccessLinksResponse) => c.json(usesAccessModeContract(c) ? result : { links: result.links });
    app.get('/:appSlug', async (c) => { const identity = await owner(c); if (!identity)
        return denied(c); const site = await options.service.get(identity); if (!site)
        throw new SiteError('not_found'); return siteResponse(c, site); });
    app.post('/:appSlug', async (c) => {
        const identity = await owner(c);
        if (!identity) return denied(c);
        const header = c.req.header('x-matrix-site-deadline');
        const now = Date.now();
        const deadlineAt = header === undefined ? now + SITE_PUBLISH_TIMEOUT_MS : Number(header);
        if ((header !== undefined && !/^\d{1,16}$/.test(header)) || !Number.isSafeInteger(deadlineAt) || deadlineAt > now + SITE_PUBLISH_TIMEOUT_MS)
            throw new SiteError('invalid_request');
        if (deadlineAt <= now) throw new SiteError('unavailable');
        const input = await c.req.json().catch((error: unknown) => {
            if (error instanceof SyntaxError) return null;
            throw error;
        });
        rejectUnnegotiatedAccessMode(c, input);
        return siteResponse(c, await options.service.deploy(identity, input, { deadlineAt, signal: c.req.raw.signal }));
    });
    app.patch('/:appSlug', async (c) => { const identity = await owner(c); if (!identity)
        return denied(c); const input = await c.req.json().catch((error: unknown) => { if (error instanceof SyntaxError)
        return null; throw error; }); rejectUnnegotiatedAccessMode(c, input); return siteResponse(c, await options.service.patch(identity, input)); });
    app.delete('/:appSlug', async (c) => {
        const identity = await owner(c);
        if (!identity)
            return denied(c);
        const input = z.object({ baseRevision: z.number().int().min(0) }).strict().safeParse(await c.req.json().catch((error: unknown) => { if (error instanceof SyntaxError)
            return null; throw error; }));
        if (!input.success)
            throw new SiteError('invalid_request');
        return siteResponse(c, await options.service.unpublish(identity, input.data.baseRevision));
    });
    app.post('/:appSlug/rollback', async (c) => { const identity = await owner(c); if (!identity)
        return denied(c); const input = SiteRollbackSchema.safeParse(await c.req.json().catch((error: unknown) => { if (error instanceof SyntaxError)
        return null; throw error; })); if (!input.success)
        throw new SiteError('invalid_request'); return siteResponse(c, await options.service.rollback(identity, input.data.versionId, input.data.baseRevision)); });
    app.get('/:appSlug/access-links', async c => {
        const identity = await owner(c, true); if (!identity) return denied(c);
        const query = SiteAccessLinksQuerySchema.safeParse({
            limit: c.req.query('limit'), cursor: c.req.query('cursor'),
        });
        if (!query.success) throw new SiteError('invalid_request');
        return accessLinksResponse(c, await options.service.listAccessLinks(identity, query.data));
    });
    app.post('/:appSlug/access-links', smallBody, async c => {
        const identity = await owner(c); if (!identity) return denied(c);
        const input = SiteAccessLinkCreateRequestSchema.safeParse(await c.req.json().catch((error: unknown) => {
            if (error instanceof SyntaxError) return null; throw error;
        }));
        if (!input.success) throw new SiteError('invalid_request');
        return c.json(await options.service.createAccessLink(identity, input.data));
    });
    app.delete('/:appSlug/access-links/:linkId', smallBody, async c => {
        const identity = await owner(c); if (!identity) return denied(c);
        const linkId = SiteIdSchema.safeParse(c.req.param('linkId'));
        if (!linkId.success) throw new SiteError('invalid_request');
        await options.service.revokeAccessLink(identity, linkId.data);
        return c.json({ ok: true });
    });
    const emailCreateBody = bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ error: 'Site unavailable' }, 413) });
    async function emailOwner(c: Context, paging = false) {
        const identity = await owner(c, paging);
        if (!identity) return null;
        if (!options.emailEnabled || !await options.emailEnabled()) throw new SiteError('unavailable');
        return identity;
    }
    const jsonBody = async (c: Context) => c.req.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) return null; throw error;
    });
    app.get('/:appSlug/invitations', async c => {
        const identity = await emailOwner(c, true); if (!identity) return denied(c);
        const input = SiteEmailInvitationListQuerySchema.safeParse({
            ...(c.req.query('limit') ? { limit: c.req.query('limit') } : {}),
            ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
        });
        if (!input.success) throw new SiteError('invalid_request');
        return c.json(await listSiteEmailInvitations(options.db, identity, input.data));
    });
    app.post('/:appSlug/invitations', emailCreateBody, async c => {
        const identity = await emailOwner(c); if (!identity) return denied(c);
        const input = SiteEmailInvitationCreateRequestSchema.safeParse(await jsonBody(c));
        if (!input.success) throw new SiteError('invalid_request');
        return c.json(await createSiteEmailInvitations(options.db, identity, input.data));
    });
    app.get('/:appSlug/invitations/audit', async c => {
        const identity = await emailOwner(c, true); if (!identity) return denied(c);
        const input = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50),
            cursor: SiteInvitationAuditCursorSchema.optional() }).strict().safeParse({
            ...(c.req.query('limit') ? { limit: c.req.query('limit') } : {}),
            ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
        });
        if (!input.success) throw new SiteError('invalid_request');
        const site = await options.db.executor.selectFrom('public_sites').select('id')
            .where('owner_id', '=', identity.ownerId).where('machine_id', '=', identity.machineId)
            .where('app_slug', '=', identity.appSlug).executeTakeFirst();
        if (!site) throw new SiteError('not_found');
        return c.json(await listSiteInvitationAuditEvents(options.db, identity.ownerId, site.id, input.data));
    });
    app.post('/:appSlug/invitations/:invitationId/resend', smallBody, async c => {
        const identity = await emailOwner(c); if (!identity) return denied(c);
        const id = SiteIdSchema.safeParse(c.req.param('invitationId'));
        const input = SiteEmailInvitationMutationRequestSchema.safeParse(await jsonBody(c));
        if (!id.success || !input.success) throw new SiteError('invalid_request');
        return c.json(await resendSiteEmailInvitation(options.db, identity, id.data, input.data));
    });
    app.delete('/:appSlug/invitations/:invitationId', smallBody, async c => {
        const identity = await emailOwner(c); if (!identity) return denied(c);
        const id = SiteIdSchema.safeParse(c.req.param('invitationId'));
        const input = SiteEmailInvitationMutationRequestSchema.safeParse(await jsonBody(c));
        if (!id.success || !input.success) throw new SiteError('invalid_request');
        return c.json(await revokeSiteEmailInvitation(options.db, identity, id.data, input.data));
    });
    return app;
}
