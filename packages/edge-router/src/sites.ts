export interface SitesWorkerEnv {
    SITES_PLATFORM_ORIGIN: string;
    SITES_EDGE_SECRET: string;
}
const reference = '(?:[a-z][a-z0-9-]{1,62}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const read = new RegExp(`^/${reference}(?:/frame|/assets/[0-9a-f-]{36}/[A-Za-z0-9_./-]{1,240})?$`);
const write = new RegExp(`^/${reference}/(?:forms/[a-z][a-z0-9_]{0,63}|access/claim)$`);
const blocked = new Set(['api', 'public', 'assets', 'frame', 'forms', 'preview', 'admin', 'auth', 'health', 'robots', 'favicon', 'index', 'sites', 'www']);
const viewerCookie = /^__Host-matrix_site_viewer_[a-f0-9]{32}=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i;
const viewerSetCookie = /^__Host-matrix_site_viewer_[a-f0-9]{32}=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/i;
function forwardedViewerCookies(raw: string | null): { value: string | null; invalid: boolean } {
    if (!raw) return { value: null, invalid: false };
    if (new TextEncoder().encode(raw).byteLength > 8192) return { value: null, invalid: true };
    const entries = raw.split(';').map(value => value.trim()).filter(Boolean);
    const viewerEntries = entries.filter(value => value.toLowerCase().startsWith('__host-matrix_site_viewer_'));
    if (viewerEntries.some(value => !viewerCookie.test(value)) || viewerEntries.length > 20)
        return { value: null, invalid: true };
    return { value: viewerEntries.length ? viewerEntries.join('; ') : null, invalid: false };
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
        const safeCookies = forwardedViewerCookies(request.headers.get('cookie'));
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
            if (response.status >= 300 && response.status < 400)
                throw new TypeError('Upstream redirect rejected');
            const result = new Response(response.body, { status: response.status, headers: response.headers });
            result.headers.delete('set-cookie');
            const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[]; getAll?: (name: string) => string[] };
            const cookies = responseHeaders.getSetCookie?.() ?? responseHeaders.getAll?.('set-cookie')
                ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
            for (const cookie of cookies)
                if (viewerSetCookie.test(cookie)) result.headers.append('set-cookie', cookie);
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
