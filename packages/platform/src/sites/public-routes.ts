import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { SiteAccessClaimSchema, SiteReferenceSchema, SiteAssetPathSchema, SiteFormSubmissionSchema, validateSiteForm, type SiteRecord } from '@matrix-os/contracts';
import type { PlatformDB } from '../db.js';
import { timingSafeTokenEquals } from '../platform-token.js';
import { createBoundedRateLimiter } from '../request-admission.js';
import { SiteError } from './types.js';
import type { SitesService } from './service.js';
import { APP_CSP, PAGE_CSP, PRIVATE_APP_CSP, siteAccessGate, siteFrame, sitePage } from './renderer.js';
import { createSiteReadAdmission } from './read-admission.js';
import { clearSiteViewerCookie } from './access-links.js';
import { MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';
import { emitSiteTelemetry, type SiteTelemetryCapture } from './telemetry.js';
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
    edgePreviousSecret?: string;
    submit: (site: SiteRecord, trx: PlatformDB, formId: string, input: z.infer<typeof SiteFormSubmissionSchema>) => Promise<{
        accepted: true;
    }>;
    captureEvent?: SiteTelemetryCapture;
}): Hono {
    const app = new Hono();
    app.onError((error, c) => unavailable(c, error));
    const perSource = createBoundedRateLimiter(20);
    const global = createBoundedRateLimiter(1200);
    let flights = 0;
    const reads = createSiteReadAdmission();
    const readSources = createBoundedRateLimiter(1200);
    const readGlobal = createBoundedRateLimiter(12000);
    function clearSiteCookies(c: Context, siteId: string) {
        c.header('Set-Cookie', clearSiteViewerCookie(siteId), { append: true });
    }
    async function authorizedSite(c: Context) {
        const parsed = SiteReferenceSchema.safeParse(c.req.param('reference'));
        if (!parsed.success) return null;
        const reference = parsed.data;
        const site = await options.service.resolve(reference);
        if (!site || site.accessMode === 'public') return site;
        return options.service.authorize(reference, c.req.header('cookie'));
    }
    app.use('*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        c.header('CDN-Cache-Control', 'no-store');
        c.header('Cloudflare-CDN-Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Referrer-Policy', 'no-referrer');
        const configuredSecrets = [options.edgeSecret, options.edgePreviousSecret]
            .filter((secret): secret is string => Boolean(secret && secret.length >= 32 && secret === secret.trim()));
        if (!options.edgeSecret || configuredSecrets.length === 0)
            return c.json({ error: 'Site unavailable' }, 503);
        const proof = c.req.header('x-matrix-sites-edge');
        let accepted = false;
        for (const secret of configuredSecrets)
            accepted = timingSafeTokenEquals(proof, secret) || accepted;
        if (!accepted)
            return c.json({ error: 'Site unavailable' }, 404);
        if (c.req.path === '/_edge-health' || c.req.path === '/public/sites/_edge-health')
            return c.json({ status: 'ok' });
        if (!SiteReferenceSchema.safeParse(c.req.path.replace(/^\/public\/sites/, '').split('/')[1]).success)
            return c.json({ error: 'Site unavailable' }, 404);
        try {
            await next();
        }
        catch (error) {
            return unavailable(c, error);
        }
    });
    app.get('/_edge-health', (c) => c.json({ status: 'ok' }));
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
    app.get('/:reference', async (c) => {
        const site = await options.service.resolve(c.req.param('reference'));
        if (!site) throw new SiteError('not_found');
        if (site.accessMode === 'private_link' && c.req.param('reference') !== site.id)
            return c.redirect(`/${site.id}`, 307);
        c.header('Content-Security-Policy', PAGE_CSP);
        if (site.accessMode === 'private_link') {
            if (!await options.service.authorize(c.req.param('reference'), c.req.header('cookie'))) {
                emitSiteTelemetry(options.captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_VIEWED,
                    { access_mode: 'private_link', access_state: 'claim_required' });
                clearSiteCookies(c, site.id);
                return c.html(siteAccessGate());
            }
            emitSiteTelemetry(options.captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_VIEWED,
                { access_mode: 'private_link', access_state: 'authorized' });
        } else {
            emitSiteTelemetry(options.captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_VIEWED,
                { access_mode: 'public', access_state: 'public' });
        }
        // A private-to-public transition invalidates the database session. Clear
        // any path-scoped browser remnants on the next canonical page request.
        if (site.accessMode === 'public' && c.req.header('cookie')) clearSiteCookies(c, site.id);
        return c.html(sitePage(site));
    });
    app.get('/:reference/frame', async (c) => { const reference = c.req.param('reference'); const site = await authorizedSite(c); if (!site?.activeVersion)
        throw new SiteError('not_found');
        if (site.accessMode === 'private_link') {
            const html = await options.service.privateFrame(reference, site.activeVersion, 'index.html');
            c.header('Content-Security-Policy', PRIVATE_APP_CSP);
            return c.html(siteFrame(html, site, 'index.html', true));
        }
        const asset = await options.service.asset(reference, site.activeVersion, 'index.html'); c.header('Content-Security-Policy', APP_CSP); return c.html(siteFrame(asset.body.toString('utf8'), site)); });
    app.get('/:reference/assets/:version/*', async (c) => {
        const version = ID.safeParse(c.req.param('version'));
        const path = SiteAssetPathSchema.safeParse(c.req.path.split(`/assets/${c.req.param('version')}/`)[1]);
        if (!version.success || !path.success)
            throw new SiteError('not_found');
        const authorized = await options.service.resolve(c.req.param('reference'));
        if (!authorized || authorized.accessMode === 'private_link') throw new SiteError('not_found');
        const asset = await options.service.asset(c.req.param('reference'), version.data, path.data);
        c.header('Content-Type', asset.contentType);
        c.header('Access-Control-Allow-Origin', 'null');
        c.header('Cross-Origin-Resource-Policy', 'cross-origin');
        // Direct app HTML navigation remains sandboxed too.
        c.header('Content-Security-Policy', APP_CSP);
        if (asset.contentType === 'text/html')
            return c.html(siteFrame(asset.body.toString('utf8'), asset.site, path.data));
        return c.body(new Uint8Array(asset.body));
    });
    app.post('/:reference/access/claim', bodyLimit({ maxSize: 2048, onError: c => c.json({ error: 'Site unavailable' }, 413) }), async c => {
        if (c.req.header('x-matrix-sites-origin') !== 'same-origin') throw new SiteError('not_found');
        const input = SiteAccessClaimSchema.safeParse(await c.req.json().catch((error: unknown) => {
            if (error instanceof SyntaxError) return null;
            throw error;
        }));
        if (!input.success) throw new SiteError('invalid_request');
        const source = c.req.header('x-matrix-sites-source') ?? 'unknown';
        if (!perSource.check(source.slice(0, 128)) || !global.check('all') || flights >= 4)
            return c.json({ error: 'Try again later' }, 429);
        flights++;
        try {
            const claimed = await options.service.claimAccessLink(c.req.param('reference'), input.data);
            c.header('Set-Cookie', claimed.cookie);
            return c.json({ accepted: true });
        } finally { flights--; }
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
        if (!perSource.check(source.slice(0, 128)) || !global.check('all') || flights >= 4)
            return c.json({ error: 'Try again later' }, 429);
        flights++;
        try {
            if (!await authorizedSite(c)) throw new SiteError('not_found');
            const accessMode = await options.service.admitted(c.req.param('reference'), async (site, trx) => {
                const form = site.config.forms.find(f => f.id === formId.data);
                if (!form)
                    throw new SiteError('not_found');
                if (!validateSiteForm(form, input.data.fields).success)
                    throw new SiteError('invalid_request');
                await options.submit(site, trx, formId.data, input.data);
                return site.accessMode;
            }, c.req.header('cookie'));
            emitSiteTelemetry(options.captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_FORM_SUBMITTED,
                { access_mode: accessMode });
            return c.json({ accepted: true });
        }
        finally {
            flights--;
        }
    });
    return app;
}
