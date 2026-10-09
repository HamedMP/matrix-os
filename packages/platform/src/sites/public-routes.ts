import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { SiteReferenceSchema, SiteAssetPathSchema, SiteFormSubmissionSchema, validateSiteForm, type SiteRecord } from '@matrix-os/contracts';
import type { PlatformDB } from '../db.js';
import { timingSafeTokenEquals } from '../platform-token.js';
import { createBoundedRateLimiter } from '../request-admission.js';
import { SiteError } from './types.js';
import type { SitesService } from './service.js';
import { APP_CSP, PAGE_CSP, siteFrame, sitePage } from './renderer.js';
import { createSiteReadAdmission } from './read-admission.js';
const ID = z.uuid();
function unavailable(c: Context, error: unknown) {
    if (error instanceof SiteError)
        return c.json({ error: error.code === 'not_found' ? 'Site unavailable' : error.code === 'invalid_request' ? 'Invalid submission' : 'Site unavailable' }, error.code === 'not_found' ? 404 : error.code === 'invalid_request' ? 400 : 503);
    console.warn('[sites] public request failed', error instanceof Error ? error.name : 'UnknownError');
    return c.json({ error: 'Site unavailable' }, 503);
}
export function createSitePublicRoutes(options: {
    service: SitesService;
    edgeSecret?: string;
    submit: (site: SiteRecord, trx: PlatformDB, formId: string, input: z.infer<typeof SiteFormSubmissionSchema>) => Promise<{
        accepted: true;
    }>;
}): Hono {
    const app = new Hono();
    app.onError((error, c) => unavailable(c, error));
    const perSource = createBoundedRateLimiter(20);
    const global = createBoundedRateLimiter(1200);
    let flights = 0;
    const reads = createSiteReadAdmission();
    const readSources = createBoundedRateLimiter(1200);
    const readGlobal = createBoundedRateLimiter(12000);
    app.use('*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        c.header('CDN-Cache-Control', 'no-store');
        c.header('Cloudflare-CDN-Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Referrer-Policy', 'no-referrer');
        if (!options.edgeSecret || options.edgeSecret.trim().length < 32)
            return c.json({ error: 'Site unavailable' }, 503);
        if (!timingSafeTokenEquals(c.req.header('x-matrix-sites-edge'), options.edgeSecret))
            return c.json({ error: 'Site unavailable' }, 404);
        if (!SiteReferenceSchema.safeParse(c.req.path.replace(/^\/public\/sites/, '').split('/')[1]).success)
            return c.json({ error: 'Site unavailable' }, 404);
        try {
            await next();
        }
        catch (error) {
            return unavailable(c, error);
        }
    });
    app.use('*', async (c, next) => {
        if (c.req.method !== 'GET') return next();
        const source = c.req.header('x-matrix-sites-source') ?? 'unknown';
        if (!readSources.check(source.slice(0, 128)) || !readGlobal.check('all'))
            return c.json({ error: 'Try again later' }, 429);
        const admission = reads.admit();
        if (!admission) return c.json({ error: 'Try again later' }, 429);
        try { await next(); c.res = admission.wrap(c.res, c.req.raw.signal); }
        catch (error) { admission.release(); throw error; }
    });
    app.get('/:reference', async (c) => { const site = await options.service.resolve(c.req.param('reference')); if (!site)
        throw new SiteError('not_found'); c.header('Content-Security-Policy', PAGE_CSP); return c.html(sitePage(site)); });
    app.get('/:reference/frame', async (c) => { const reference = c.req.param('reference'); const site = await options.service.resolve(reference); if (!site?.activeVersion)
        throw new SiteError('not_found'); const asset = await options.service.asset(reference, site.activeVersion, 'index.html'); c.header('Content-Security-Policy', APP_CSP); return c.html(siteFrame(asset.body.toString('utf8'), site)); });
    app.get('/:reference/assets/:version/*', async (c) => {
        const version = ID.safeParse(c.req.param('version'));
        const path = SiteAssetPathSchema.safeParse(c.req.path.split(`/assets/${c.req.param('version')}/`)[1]);
        if (!version.success || !path.success)
            throw new SiteError('not_found');
        const asset = await options.service.asset(c.req.param('reference'), version.data, path.data);
        c.header('Content-Type', asset.contentType);
        c.header('Access-Control-Allow-Origin', 'null');
        c.header('Cross-Origin-Resource-Policy', 'cross-origin');
        // Direct app HTML navigation remains sandboxed too.
        c.header('Content-Security-Policy', APP_CSP);
        return c.body(new Uint8Array(asset.body));
    });
    app.post('/:reference/forms/:formId', bodyLimit({ maxSize: 17 * 1024, onError: c => c.json({ error: 'Invalid submission' }, 413) }), async (c) => {
        const formId = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/).safeParse(c.req.param('formId'));
        if (!formId.success)
            throw new SiteError('invalid_request');
        const input = SiteFormSubmissionSchema.safeParse(await c.req.json().catch((error: unknown) => { if (error instanceof SyntaxError)
            return null; throw error; }));
        if (!input.success)
            throw new SiteError('invalid_request');
        const source = c.req.header('x-matrix-sites-source') ?? 'unknown';
        if (!perSource.check(source.slice(0, 128)) || !global.check('all') || flights >= 16)
            return c.json({ error: 'Try again later' }, 429);
        flights++;
        try {
            return await options.service.admitted(c.req.param('reference'), async (site, trx) => {
                const form = site.config.forms.find(f => f.id === formId.data);
                if (!form)
                    throw new SiteError('not_found');
                if (!validateSiteForm(form, input.data.fields).success)
                    throw new SiteError('invalid_request');
                await options.submit(site, trx, formId.data, input.data);
                return c.json({ accepted: true });
            });
        }
        finally {
            flights--;
        }
    });
    return app;
}
