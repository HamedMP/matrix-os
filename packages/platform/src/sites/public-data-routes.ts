import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SITE_PUBLIC_DATA_REQUEST_MAX_BYTES, SiteReferenceSchema, SitePublicDataRequestSchema, isSitePublicDataWrite } from '@matrix-os/contracts';
import { createBoundedRateLimiter } from '../request-admission.js';
import { SiteError } from './types.js';
import type { SitesService } from './service.js';
import type { SiteDataOutcome, SiteDataTransport } from './data-transport.js';

const UNAVAILABLE = 'Shared data is unavailable';
const MAX_IN_FLIGHT = 32;

function respond(c: Context, outcome: SiteDataOutcome) {
    if (outcome.ok) return c.json({ result: outcome.result });
    if (outcome.status === 400) return c.json({ error: 'Invalid change' }, 400);
    if (outcome.status === 429) return c.json({ error: 'Try again later' }, 429);
    return c.json({ error: UNAVAILABLE }, 503);
}

/**
 * Public-site visitor data (2694). Mounted inside the public site routes, after the
 * edge-proof middleware. Visitors reach only the published app of a public site.
 */
export function registerSitePublicDataRoute(app: Hono, options: {
    service: SitesService;
    transport: SiteDataTransport;
    env?: NodeJS.ProcessEnv;
    limits?: { perSource?: number; perSourceWrites?: number; perSite?: number; global?: number };
}): void {
    // Bounded, evicting windows keyed by the edge-reported visitor source.
    const perSource = createBoundedRateLimiter(options.limits?.perSource ?? 300);
    const perSourceWrites = createBoundedRateLimiter(options.limits?.perSourceWrites ?? 60);
    const perSite = createBoundedRateLimiter(options.limits?.perSite ?? 3000);
    const global = createBoundedRateLimiter(options.limits?.global ?? 30000);
    let flights = 0;
    app.post('/:reference/data', bodyLimit({ maxSize: SITE_PUBLIC_DATA_REQUEST_MAX_BYTES, onError: c => c.json({ error: 'Invalid change' }, 413) }), async (c) => {
        // Operator kill switch, read per request: an env update stops data fleet-wide without a code deploy.
        if ((options.env ?? process.env).SITES_PUBLIC_DATA === 'off') return c.json({ error: UNAVAILABLE }, 503);
        if (c.req.header('x-matrix-sites-origin') !== 'same-origin') return c.json({ error: 'Site unavailable' }, 404);
        const reference = SiteReferenceSchema.safeParse(c.req.param('reference'));
        if (!reference.success) return c.json({ error: 'Site unavailable' }, 404);
        const input = SitePublicDataRequestSchema.safeParse(await c.req.json().catch((error: unknown) => {
            if (error instanceof SyntaxError) return null;
            throw error;
        }));
        if (!input.success) return c.json({ error: 'Invalid change' }, 400);
        const write = isSitePublicDataWrite(input.data);
        const source = (c.req.header('x-matrix-sites-source') ?? 'unknown').slice(0, 128);
        if (!perSource.check(source) || (write && !perSourceWrites.check(source)) || !global.check('all') || flights >= MAX_IN_FLIGHT)
            return c.json({ error: 'Try again later' }, 429);
        flights++;
        try {
            const site = await options.service.resolve(reference.data);
            if (!site || site.accessMode !== 'public' || !site.activeVersion) return c.json({ error: 'Site unavailable' }, 404);
            if (!perSite.check(site.id)) return c.json({ error: 'Try again later' }, 429);
            const visitor = options.transport.visitorHash(site.id, source);
            // Writes hold the publication row lock through forwarding (551 R7), so unpublish or a
            // switch to private link either precedes the write or waits for it.
            const outcome = write
                ? await options.service.admitted(reference.data, async (locked, trx) => {
                    if (locked.id !== site.id || locked.accessMode !== 'public' || !locked.activeVersion) throw new SiteError('not_found');
                    return options.transport.forward(locked, visitor, input.data, trx);
                })
                : await options.transport.forward(site, visitor, input.data);
            return respond(c, outcome);
        } catch (error: unknown) {
            if (error instanceof SiteError && error.code === 'not_found') return c.json({ error: 'Site unavailable' }, 404);
            console.warn('[sites] public data request failed', error instanceof Error ? error.name : 'UnknownError');
            return c.json({ error: UNAVAILABLE }, 503);
        } finally {
            flights--;
        }
    });
}
