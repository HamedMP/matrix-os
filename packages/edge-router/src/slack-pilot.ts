/** An explicit, expiring legacy pilot. This is not the spec 530 Preview identity boundary. */
export interface SlackPilotEnv {
  SLACK_PILOT_PUBLIC_ORIGIN?: string;
  SLACK_PILOT_UPSTREAM_ORIGIN?: string;
  SLACK_PILOT_NOT_AFTER?: string;
}

const BODY_LIMIT = 256 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_REMAINING_MS = 7 * 24 * 60 * 60 * 1000;

function failure(status = 503, message = 'Preview unavailable'): Response {
  return new Response(message, { status, headers: { 'cache-control': 'no-store' } });
}

function configuration(env: SlackPilotEnv): { publicOrigin: string; upstream: string } | null {
  try {
    const publicUrl = new URL(env.SLACK_PILOT_PUBLIC_ORIGIN ?? '');
    const upstream = new URL(env.SLACK_PILOT_UPSTREAM_ORIGIN ?? '');
    const pr = /^pr-([1-9][0-9]{0,8})-preview\.matrix-os\.com$/.exec(publicUrl.hostname)?.[1];
    const expiry = Date.parse(env.SLACK_PILOT_NOT_AFTER ?? '');
    if (!pr || !Number.isFinite(expiry) || expiry <= Date.now() || expiry - Date.now() > MAX_REMAINING_MS) return null;
    for (const url of [publicUrl, upstream]) {
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || url.pathname !== '/' || url.search || url.hash) return null;
    }
    if (!new RegExp(`^pr-${pr}---matrix-platform-preview-[a-z0-9-]+\\.a\\.run\\.app$`).test(upstream.hostname)) return null;
    return { publicOrigin: publicUrl.origin, upstream: upstream.origin };
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function isAuthPath(path: string): boolean {
  return /^(?:\/__platform-shell)?\/sign-(?:in|up)(?:\/.*)?$/.test(path);
}

function allowedMethods(path: string): string[] {
  if (isAuthPath(path)) return ['GET', 'HEAD', 'POST'];
  if (path === '/' || path === '/slack/link'
    || path === '/api/slack/oauth/callback' || /^(?:\/__platform-shell)?\/_next\/static\//.test(path)
    || /^\/(?:icons|fonts|textures)\//.test(path) || path === '/favicon.ico') return ['GET', 'HEAD'];
  if (path === '/api/slack/install' || path === '/api/slack/link/complete'
    || path === '/webhooks/slack/events') return ['POST'];
  if (/^\/api\/slack\/workspaces\/T[A-Za-z0-9]{1,127}\/channels\/C[A-Za-z0-9]{1,127}$/.test(path)) return ['PUT'];
  if (/^\/api\/slack\/workspaces\/T[A-Za-z0-9]{1,127}(?:\/link)?$/.test(path)) return ['DELETE'];
  return [];
}

async function body(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return null;
  if (Number(request.headers.get('content-length')) > BODY_LIMIT) throw new RangeError('body limit');
  const reader = request.body.getReader();
  const bytes = new Uint8Array(BODY_LIMIT);
  let length = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch((error: unknown) => {
      console.warn('[slack-pilot] body cancellation failed', error instanceof Error ? error.name : typeof error);
    });
  }, TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error('body timeout');
      if (done) break;
      if (value.byteLength > BODY_LIMIT - length) throw new RangeError('body limit');
      bytes.set(value, length); length += value.byteLength;
    }
    return bytes.slice(0, length);
  } finally {
    clearTimeout(timer);
    // Explicitly stop a too-large producer rather than leaving its stream running.
    await reader.cancel().catch((error: unknown) => {
      console.warn('[slack-pilot] body cleanup failed', error instanceof Error ? error.name : typeof error);
    });
    reader.releaseLock();
  }
}

function redirectLocation(location: string, upstream: string, publicOrigin: string): string {
  let url: URL;
  try { url = new URL(location, upstream); }
  catch (error: unknown) { if (error instanceof TypeError) return location; throw error; }
  const ownRedirect = url.origin === upstream;
  const clerkHandshake = url.origin === 'https://clerk.matrix-os.com'
    && url.pathname === '/v1/client/handshake' && !url.username && !url.password;
  if (!ownRedirect && !clerkHandshake) return location;
  // The already-built auth shell's canonical origin is the run.app tag. Preserve the
  // path and query while keeping that shell's own redirects on this approved alias.
  const returnUrl = url.searchParams.get('redirect_url');
  if (returnUrl) {
    try {
      const target = new URL(returnUrl);
      // Next's local auth proxy is plain HTTP. Only this exact Clerk handshake
      // may normalize its matching preview return; never follow it or log tokens.
      const matchingOrigin = target.origin === upstream
        || (clerkHandshake && target.origin === upstream.replace('https:', 'http:'));
      if (matchingOrigin && !target.username && !target.password) {
        url.searchParams.set('redirect_url', publicOrigin + target.pathname + target.search + target.hash);
      }
    } catch (error: unknown) { if (!(error instanceof TypeError)) throw error; }
  }
  return ownRedirect ? publicOrigin + url.pathname + url.search + url.hash : url.href;
}

export async function handleSlackPilotRequest(request: Request, env: SlackPilotEnv): Promise<Response> {
  const config = configuration(env);
  if (!config) return failure();
  const url = new URL(request.url);
  if (url.origin !== config.publicOrigin) return failure(404, 'Not found');
  const methods = allowedMethods(url.pathname);
  if (!methods.length) return failure(404, 'Not found');
  if (!methods.includes(request.method)) return failure(405, 'Method not allowed');
  const authAction = isAuthPath(url.pathname) && request.method === 'POST';
  if (authAction && request.headers.get('origin') !== config.publicOrigin) return failure(403, 'Forbidden');
  if (url.pathname.startsWith('/api/slack/') && !['GET', 'HEAD'].includes(request.method)) {
    const nativeBearer = /^Bearer [A-Za-z0-9._~-]{1,4096}$/i.test(request.headers.get('authorization') ?? '');
    if (request.headers.get('origin') !== config.publicOrigin
      && !(request.headers.get('origin') === null && nativeBearer && !request.headers.has('cookie'))) return failure(403, 'Forbidden');
  }
  let bytes: Uint8Array<ArrayBuffer> | null;
  try { bytes = await body(request); }
  catch (error: unknown) { return error instanceof RangeError ? failure(413, 'Payload too large') : failure(); }
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (key === 'host' || key.startsWith('x-forwarded-') || key.startsWith('x-platform-')
      || key.startsWith('x-matrix-') || (key === 'next-action' && !authAction)) headers.delete(key);
  }
  headers.set('x-forwarded-host', url.hostname);
  headers.set('x-forwarded-proto', 'https');
  let response: Response;
  try {
    response = await fetch(new Request(config.upstream + url.pathname + url.search, {
      method: request.method, headers, body: bytes, redirect: 'manual',
    }), { redirect: 'manual', signal: AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  } catch (error: unknown) {
    console.warn('[slack-pilot] upstream unavailable', error instanceof Error ? error.name : typeof error);
    return failure();
  }
  const output = new Headers(response.headers);
  for (const key of [...output.keys()]) if (key.startsWith('access-control-allow-')) output.delete(key);
  for (const key of ['cache-control', 'cdn-cache-control', 'cloudflare-cdn-cache-control']) output.set(key, 'no-store');
  const location = output.get('location');
  if (location) output.set('location', redirectLocation(location, config.upstream, config.publicOrigin));
  const cookieHeaders = response.headers as Headers & { getAll?: (name: string) => string[]; getSetCookie?: () => string[] };
  const cookies = cookieHeaders.getSetCookie?.() ?? cookieHeaders.getAll?.('set-cookie') ?? [];
  output.delete('set-cookie');
  for (const cookie of cookies) if (!/;\s*domain\s*=/i.test(cookie)) output.append('set-cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: output });
}

export default { fetch: handleSlackPilotRequest };
