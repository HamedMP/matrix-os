export interface SitesWorkerEnv {
    SITES_PLATFORM_ORIGIN: string;
    SITES_EDGE_SECRET: string;
}
const reference = '(?:[a-z][a-z0-9-]{1,62}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const read = new RegExp(`^/${reference}(?:/frame|/assets/[0-9a-f-]{36}/[A-Za-z0-9_./-]{1,240})?$`);
const write = new RegExp(`^/${reference}/(?:forms/[a-z][a-z0-9_]{0,63}|access/claim)$`);
const blocked = new Set(['api', 'public', 'assets', 'frame', 'forms', 'preview', 'admin', 'auth', 'health', 'robots', 'favicon', 'index', 'sites', 'www']);
const siteIdPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const viewerCookie = new RegExp(`^__Secure-matrix_site_viewer_([a-f0-9]{32})=${siteIdPattern}\\.[A-Za-z0-9_-]{43}$`, 'i');
const viewerSetCookie = new RegExp(`^__Secure-matrix_site_viewer_([a-f0-9]{32})=${siteIdPattern}\\.[A-Za-z0-9_-]{43}; Path=\/(${siteIdPattern}); HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$`, 'i');
const viewerClearCookie = new RegExp(`^__Secure-matrix_site_viewer_([a-f0-9]{32})=; Path=\/(${siteIdPattern}); HttpOnly; Secure; SameSite=Lax; Max-Age=0$`, 'i');
const matrixCookiePrefix = /^__(?:Secure-matrix_site_viewer_|Host-matrix_site_viewer_)/i;
function pathSiteId(pathname: string): string | null {
    const candidate = pathname.split('/')[1] ?? '';
    return new RegExp(`^${siteIdPattern}$`, 'i').test(candidate) ? candidate.toLowerCase() : null;
}
function approvedSetCookie(cookie: string, targetSiteId: string | null): boolean {
    if (!targetSiteId) return false;
    const match = viewerSetCookie.exec(cookie) ?? viewerClearCookie.exec(cookie);
    return Boolean(match && match[1]?.toLowerCase() === targetSiteId.replaceAll('-', '') && match[2]?.toLowerCase() === targetSiteId);
}
function forwardedViewerCookies(raw: string | null, targetSiteId: string | null): { value: string | null; invalid: boolean } {
    if (!raw) return { value: null, invalid: false };
    if (new TextEncoder().encode(raw).byteLength > 8192) return { value: null, invalid: true };
    const entries = raw.split(';').map(value => value.trim()).filter(Boolean);
    const viewerEntries = entries.filter(value => matrixCookiePrefix.test(value));
    const parsed = viewerEntries.map(value => ({ value, match: viewerCookie.exec(value) }));
    if (parsed.some(value => !value.match))
        return { value: null, invalid: true };
    if (!targetSiteId) return { value: null, invalid: false };
    const suffix = targetSiteId.replaceAll('-', '');
    const matching = parsed.filter(value => value.match?.[1]?.toLowerCase() === suffix).map(value => value.value);
    if (matching.length > 1) return { value: null, invalid: true };
    return { value: matching.length ? matching.join('; ') : null, invalid: false };
}
async function handleSiteRequest(request: Request, env: SitesWorkerEnv): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD'))
            return new Response(null, { status: 302, headers: { Location: 'https://matrix-os.com', 'Cache-Control': 'no-store' } });
        const edgeHealth = request.method === 'GET' && url.pathname === '/_edge-health';
        const valid = edgeHealth || (request.method === 'GET' ? read.test(url.pathname) : request.method === 'POST' && write.test(url.pathname));
        if (!valid || blocked.has(url.pathname.split('/')[1]!))
            return new Response('Site unavailable', { status: 404 });
        if ([...url.searchParams.keys()].some(key => ['access', 'token', 'linkid', 'session'].includes(key.toLowerCase())))
            return new Response('Site unavailable', { status: 400 });
        let origin: URL;
        try {
            origin = new URL(env.SITES_PLATFORM_ORIGIN);
            if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || env.SITES_EDGE_SECRET.length < 32)
                throw Error();
        }
        catch (error) {
            console.warn('[sites] Worker request unavailable', error instanceof Error ? error.name : 'UnknownError');
            return new Response('Site unavailable', { status: 503 });
        }
        // Version/cache-busting queries in accepted build assets are harmless:
        // read the immutable path and never forward visitor query values.
        if (url.search && request.method !== 'GET')
            return new Response('Site unavailable', { status: 400 });
        const claim = request.method === 'POST' && url.pathname.endsWith('/access/claim');
        if (claim && request.headers.get('origin') !== url.origin)
            return new Response('Site unavailable', { status: 404 });
        const headers = new Headers({ 'x-matrix-sites-edge': env.SITES_EDGE_SECRET, 'x-matrix-sites-source': request.headers.get('cf-connecting-ip') ?? 'unknown' });
        if (request.method === 'POST')
            headers.set('content-type', 'application/json');
        if (claim)
            headers.set('x-matrix-sites-origin', 'same-origin');
        const targetSiteId = pathSiteId(url.pathname);
        const safeCookies = forwardedViewerCookies(request.headers.get('cookie'), targetSiteId);
        if (safeCookies.invalid)
            return new Response('Site unavailable', { status: 400 });
        if (safeCookies.value)
            headers.set('cookie', safeCookies.value);
        let body: Uint8Array | undefined;
        if (request.method === 'POST') {
            if (!request.body)
                return new Response('Invalid submission', { status: 400 });
            const reader = request.body.getReader();
            const parts: Uint8Array[] = [];
            let size = 0;
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done)
                        break;
                    size += chunk.value.length;
                    if (size > (claim ? 2048 : 17 * 1024)) {
                        await reader.cancel();
                        return new Response('Invalid submission', { status: 413 });
                    }
                    parts.push(chunk.value);
                }
            }
            catch (error) {
                console.warn('[sites] Worker body unavailable', error instanceof Error ? error.name : 'UnknownError');
                return new Response('Invalid submission', { status: 400 });
            }
            finally {
                reader.releaseLock();
            }
            body = new Uint8Array(size);
            let offset = 0;
            for (const part of parts) {
                body.set(part, offset);
                offset += part.length;
            }
        }
        try {
            const upstream = new Request(`${origin.origin}/public/sites${url.pathname}`, { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(request.method === 'POST' ? 10000 : 30000) });
            const response = await fetch(upstream, { signal: upstream.signal });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                const canonical = request.method === 'GET' && (response.status === 307 || response.status === 308)
                    && new RegExp(`^/${reference}$`).test(url.pathname)
                    && Boolean(location && new RegExp(`^/${siteIdPattern}$`, 'i').test(location));
                if (!canonical) throw new TypeError('Upstream redirect rejected');
                return new Response(null, { status: response.status, headers: {
                    Location: location!, 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store',
                } });
            }
            const result = new Response(response.body, { status: response.status, headers: response.headers });
            result.headers.delete('set-cookie');
            const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[]; getAll?: (name: string) => string[] };
            const cookies = responseHeaders.getSetCookie?.() ?? responseHeaders.getAll?.('set-cookie')
                ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
            for (const cookie of cookies)
                if (approvedSetCookie(cookie, targetSiteId)) result.headers.append('set-cookie', cookie);
            result.headers.set('Cache-Control', 'no-store');
            result.headers.set('CDN-Cache-Control', 'no-store');
            return result;
        }
        catch (error) {
            console.warn('[sites] Worker request unavailable', error instanceof Error ? error.name : 'UnknownError');
            return new Response('Site unavailable', { status: 503 });
        }
}
export default { fetch: handleSiteRequest };
