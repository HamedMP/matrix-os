import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  createDeviceFlow,
  type DeviceFlow,
  normalizeUserCode,
} from './device-flow.js';
import {
  issueSyncJwt,
  verifySyncJwt,
  type SyncJwtClaims,
} from './sync-jwt.js';
import type { PlatformDB } from './db.js';
import { getContainer, getContainerByClerkId } from './db.js';
import type { ClerkAuth } from './clerk-auth.js';

const DEVICE_BODY_LIMIT = 4096;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_MAX_KEYS = 10_000;

export interface AuthRoutesConfig {
  db: PlatformDB;
  clerkAuth?: ClerkAuth;
  jwtSecret: string;
  platformUrl: string; // e.g. https://platform.matrix-os.com
  gatewayUrlForHandle: (handle: string) => string;
  now?: () => number;
}

interface RateLimiter {
  check(key: string): boolean;
}

function createRateLimiter(): RateLimiter {
  const windows = new Map<string, number[]>();

  function upsertWindow(key: string, entries: number[]): void {
    if (windows.has(key)) windows.delete(key);
    windows.set(key, entries);
    if (windows.size > RATE_LIMIT_MAX_KEYS) {
      const first = windows.keys().next().value;
      if (first !== undefined && first !== key) windows.delete(first);
    }
  }

  return {
    check(key: string): boolean {
      const now = Date.now();
      const cutoff = now - RATE_LIMIT_WINDOW_MS;
      const arr = (windows.get(key) ?? []).filter((t) => t > cutoff);
      if (arr.length >= RATE_LIMIT_MAX) {
        upsertWindow(key, arr);
        return false;
      }
      arr.push(now);
      upsertWindow(key, arr);
      return true;
    },
  };
}

function forwardedClientIp(c: import('hono').Context): string | null {
  const forwarded = c.req.header('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return first ?? null;
}

function clientIp(c: import('hono').Context): string {
  return (
    c.req.header('cf-connecting-ip')?.trim() ||
    c.req.header('x-real-ip')?.trim() ||
    forwardedClientIp(c) ||
    '127.0.0.1'
  );
}

function csrfToken(): string {
  return randomBytes(16).toString('hex');
}

function csrfCookieMatchesForm(cookieValue: string, formValue: string): boolean {
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(formValue);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function readCsrfCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)device_csrf=([^;]+)/);
  return m ? m[1] : null;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

function isSyncJwtConfigError(err: unknown): boolean {
  return err instanceof Error && (
    err.message === 'verifySyncJwt requires either secret or publicKey' ||
    err.message.includes('PLATFORM_JWT_SECRET must be at least 32 characters')
  );
}

function approvalPage(
  userCode: string,
  csrf: string,
  publishableKey: string | null,
  scriptNonce: string,
): string {
  // Renders an HTML page that lets a Clerk-authenticated user confirm the
  // device pairing. The Clerk widget is loaded for sign-in if needed; once
  // a session exists, the form POSTs to /auth/device/approve. The CSRF
  // value is also written as a cookie via Set-Cookie on this response so
  // POST /auth/device/approve can verify the double-submit.
  const escapedCode = userCode.replace(/[^A-Z0-9-]/gi, '');
  const escapedCsrf = csrf.replace(/[^a-f0-9]/gi, '');
  const escapedPublishableKey = publishableKey
    ? escapeHtmlAttr(publishableKey)
    : null;
  const clerkScript = publishableKey
    ? `
  <script
    nonce="${scriptNonce}"
    async crossorigin="anonymous"
    data-clerk-publishable-key="${escapedPublishableKey}"
    src="https://clerk.matrix-os.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
    onload="initClerk()"></script>
  <script nonce="${scriptNonce}">
    function initClerk() {
      window.Clerk.load().then(function() {
        var hasSession = !!window.Clerk.user;
        document.getElementById('signin-area').style.display = hasSession ? 'none' : 'block';
        document.getElementById('confirm-area').style.display = hasSession ? 'block' : 'none';
        if (!hasSession) {
          window.Clerk.mountSignIn(document.getElementById('signin-area'));
        }
      });
    }
  </script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize device -- Matrix OS</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0a0a0a; color: #eee; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { max-width: 420px; padding: 2rem; background: #141414; border: 1px solid #222; border-radius: 8px; text-align: center; }
    h1 { margin: 0 0 1rem; font-size: 1.25rem; }
    .code { font-family: monospace; font-size: 1.5rem; letter-spacing: 0.1em; padding: 0.5rem 1rem; background: #1f1f1f; border-radius: 6px; margin: 1rem 0; }
    button { background: #3b82f6; color: white; border: 0; padding: 0.6rem 1.2rem; font-size: 1rem; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize this device</h1>
    <p>You're approving:</p>
    <div class="code">${escapedCode}</div>
    <div id="signin-area" style="display:none"></div>
    <form id="confirm-area" method="POST" action="/auth/device/approve" style="display:block">
      <input type="hidden" name="userCode" value="${escapedCode}">
      <input type="hidden" name="csrf" value="${escapedCsrf}">
      <button type="submit">Confirm</button>
    </form>
  </div>
  ${clerkScript}
</body>
</html>`;
}

function approvalSuccessPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Authorized</title>
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#eee;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{max-width:380px;padding:2rem;background:#141414;border:1px solid #222;border-radius:8px;text-align:center}</style></head>
<body><div class="card"><h1>Login successful</h1><p>You can close this tab and return to your terminal.</p></div></body></html>`;
}

function applyNoFrameHeaders(
  c: import('hono').Context,
  scriptNonce?: string,
): void {
  c.header('X-Frame-Options', 'DENY');
  const scriptSrc = scriptNonce
    ? `'self' 'nonce-${scriptNonce}' https://clerk.matrix-os.com`
    : `'self' https://clerk.matrix-os.com`;
  c.header(
    'Content-Security-Policy',
    `frame-ancestors 'none'; script-src ${scriptSrc}; object-src 'none'; base-uri 'none'`,
  );
}

export function createAuthRoutes(config: AuthRoutesConfig): Hono {
  const app = new Hono();
  const rateLimit = createRateLimiter();

  const flow: DeviceFlow = createDeviceFlow({
    db: config.db,
    verificationBase: config.platformUrl,
    now: config.now,
    issueToken: async ({ clerkUserId }) => {
      const container = getContainerByClerkId(config.db, clerkUserId);
      if (!container) {
        throw new Error('No container provisioned for this Clerk user');
      }
      const gatewayUrl = config.gatewayUrlForHandle(container.handle);
      const issued = await issueSyncJwt({
        secret: config.jwtSecret,
        clerkUserId,
        handle: container.handle,
        gatewayUrl,
      });
      return {
        token: issued.token,
        expiresAt: issued.expiresAt,
        handle: container.handle,
      };
    },
  });

  // POST /api/auth/device/code -- public
  app.post(
    '/api/auth/device/code',
    bodyLimit({ maxSize: DEVICE_BODY_LIMIT }),
    async (c) => {
      if (!rateLimit.check(clientIp(c))) {
        return c.json({ error: 'too_many_requests' }, 429);
      }
      // Read body to engage bodyLimit and validate the clientId. RFC 8628
      // doesn't require a clientId, but we keep one for usage analytics
      // and to lay the groundwork for per-client policy.
      let body: { clientId?: unknown };
      try {
        body = await c.req.json();
      } catch (err: unknown) {
        console.error(
          '[device/code] JSON parse failed:',
          err instanceof Error ? err.message : String(err),
        );
        return c.json({ error: 'invalid_request' }, 400);
      }
      if (typeof body.clientId !== 'string' || body.clientId.length > 256) {
        return c.json({ error: 'invalid_client' }, 400);
      }

      try {
        const issued = await flow.createDeviceCode();
        return c.json({
          deviceCode: issued.deviceCode,
          userCode: issued.userCode,
          verificationUri: issued.verificationUri,
          expiresIn: issued.expiresIn,
          interval: issued.interval,
        });
      } catch (err) {
        console.error('[device/code] failed:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'server_error' }, 500);
      }
    },
  );

  // POST /api/auth/device/token -- public; polled by CLI.
  app.post(
    '/api/auth/device/token',
    bodyLimit({ maxSize: DEVICE_BODY_LIMIT }),
    async (c) => {
      if (!rateLimit.check(clientIp(c))) {
        return c.json({ error: 'too_many_requests' }, 429);
      }
      let body: { deviceCode?: string };
      try {
        body = await c.req.json();
      } catch (err: unknown) {
        console.error(
          '[device/token] JSON parse failed:',
          err instanceof Error ? err.message : String(err),
        );
        return c.json({ error: 'invalid_request' }, 400);
      }
      if (!body.deviceCode || typeof body.deviceCode !== 'string') {
        return c.json({ error: 'invalid_request' }, 400);
      }

      try {
        const result = await flow.pollDeviceCode(body.deviceCode);
        switch (result.status) {
          case 'pending':
            return c.json({ error: 'authorization_pending' }, 428);
          case 'slow_down':
            return c.json({ error: 'slow_down' }, 429);
          case 'expired':
            return c.json({ error: 'expired_token' }, 410);
          case 'approved':
            return c.json({
              accessToken: result.token,
              expiresAt: result.expiresAt,
              userId: result.clerkUserId,
              handle: result.handle,
            });
        }
      } catch (err) {
        console.error('[device/token] failed:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'server_error' }, 500);
      }
    },
  );

  // GET /auth/device?user_code=ABCD-EFGH -- public; renders approval HTML.
  app.get('/auth/device', (c) => {
    const userCodeRaw = c.req.query('user_code') ?? '';
    if (!userCodeRaw) {
      return c.text('Missing user_code', 400);
    }
    const csrf = csrfToken();
    const scriptNonce = randomBytes(16).toString('base64');
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null;

    // Set the CSRF cookie -- HttpOnly so JS can't exfiltrate, SameSite=Strict
    // so a cross-site form can't replay. Secure in production (set by env).
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    c.header(
      'Set-Cookie',
      `device_csrf=${csrf}; Path=/auth/device; Max-Age=900; HttpOnly; SameSite=Strict${secure}`,
    );
    applyNoFrameHeaders(c, scriptNonce);
    return c.html(approvalPage(userCodeRaw, csrf, publishableKey, scriptNonce));
  });

  // POST /auth/device/approve -- requires Clerk session + CSRF cookie/form match.
  app.post(
    '/auth/device/approve',
    bodyLimit({ maxSize: DEVICE_BODY_LIMIT }),
    async (c) => {
      if (!rateLimit.check(clientIp(c))) {
        return c.json({ error: 'too_many_requests' }, 429);
      }
      if (!config.clerkAuth) {
        return c.json({ error: 'clerk_not_configured' }, 500);
      }

      const token = config.clerkAuth.extractToken(
        c.req.header('authorization'),
        c.req.header('cookie'),
      );
      if (!token) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      const verifyResult = await config.clerkAuth.verify(token);
      if (!verifyResult.authenticated || !verifyResult.userId) {
        return c.json({ error: 'unauthorized' }, 401);
      }

      const cookieCsrf = readCsrfCookie(c.req.header('cookie'));
      let formCsrf: string | undefined;
      let userCode: string | undefined;
      try {
        const form = await c.req.parseBody();
        formCsrf = typeof form.csrf === 'string' ? form.csrf : undefined;
        userCode = typeof form.userCode === 'string' ? form.userCode : undefined;
      } catch (err: unknown) {
        console.error(
          '[device-flow] Form parse failed:',
          err instanceof Error ? err.message : String(err),
        );
        return c.json({ error: 'invalid_request' }, 400);
      }

      if (
        !cookieCsrf ||
        !formCsrf ||
        !csrfCookieMatchesForm(cookieCsrf, formCsrf)
      ) {
        return c.json({ error: 'csrf_mismatch' }, 403);
      }
      if (!userCode || normalizeUserCode(userCode).length !== 8) {
        return c.json({ error: 'invalid_request' }, 400);
      }

      try {
        await flow.approveDeviceCode(userCode, verifyResult.userId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'approval failed';
        console.error('[device/approve] failed:', msg);
        if (/expired/i.test(msg)) return c.json({ error: 'expired_token' }, 410);
        if (/unknown/i.test(msg)) return c.json({ error: 'invalid_user_code' }, 404);
        return c.json({ error: 'server_error' }, 500);
      }

      applyNoFrameHeaders(c);
      return c.html(approvalSuccessPage());
    },
  );

  // GET /api/me -- authed via sync JWT. Returns handle + gatewayUrl.
  app.get('/api/me', async (c) => {
    if (!rateLimit.check(clientIp(c))) {
      return c.json({ error: 'too_many_requests' }, 429);
    }
    const auth = c.req.header('authorization');
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const token = auth.slice(7);
    let claims: SyncJwtClaims;
    try {
      claims = await verifySyncJwt(token, { secret: config.jwtSecret });
    } catch (err: unknown) {
      if (isSyncJwtConfigError(err)) {
        throw err;
      }
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!claims.sub || !claims.handle) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const container = getContainer(config.db, claims.handle);
    if (!container) {
      return c.json({ error: 'unknown_handle' }, 404);
    }
    return c.json({
      userId: claims.sub,
      handle: container.handle,
      gatewayUrl: config.gatewayUrlForHandle(container.handle),
    });
  });

  return app;
}
