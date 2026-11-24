import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SITE_PUBLIC_DATA_REQUEST_MAX_BYTES, SiteReferenceSchema, SitePublicDataRequestSchema, isSitePublicDataWrite } from '@matrix-os/contracts';
import { createBoundedRateLimiter } from '../request-admission.js';
import { SiteError } from './types.js';
import type { SitesService } from './service.js';
import type { SiteDataOutcome, SiteDataTransport } from './data-transport.js';

const UNAVAILABLE = 'Shared data is unavailable';
const MAX_IN_FLIGHT = 32;
// Locked writes hold a platform DB connection while the owner gateway answers (<= 10s).
// Keep most of the shared pool (10 connections) free for reads, management and other users.
const MAX_WRITES_IN_FLIGHT = 3;

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
    let writeFlights = 0;
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
        if (!global.check('all') || flights >= MAX_IN_FLIGHT) return c.json({ error: 'Try again later' }, 429);
        flights++;
        try {
            const site = await options.service.resolve(reference.data);
            // Links published before visitor data shipped have no owner opt-in and serve no app data.
            if (!site || site.accessMode !== 'public' || !site.activeVersion || !site.publicData) return c.json({ error: 'Site unavailable' }, 404);
            // Visitor budgets are per source and site, so one site's traffic never spends another's.
            const visitorKey = `${site.id}\0${source}`;
            if (!perSource.check(visitorKey) || (write && !perSourceWrites.check(visitorKey)) || !perSite.check(site.id))
                return c.json({ error: 'Try again later' }, 429);
            const visitor = options.transport.visitorHash(site.id, source);
            // Writes re-check the publication under a row share lock held through forwarding.
            let outcome: SiteDataOutcome;
            if (write) {
                if (writeFlights >= MAX_WRITES_IN_FLIGHT) return c.json({ error: 'Try again later' }, 429);
                writeFlights++;
                try { outcome = await options.transport.forwardWrite(site, visitor, input.data); }
                finally { writeFlights--; }
            } else {
                outcome = await options.transport.forward(site, visitor, input.data);
            }
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
