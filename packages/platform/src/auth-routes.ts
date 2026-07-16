import { createHmac, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MatrixComputerRuntimeSlotSchema } from '@matrix-os/contracts';
import {
  createDeviceFlow,
  type DeviceFlow,
  type DeviceProfile,
  normalizeUserCode,
} from './device-flow.js';
import {
  issueSyncJwt,
  verifySyncJwt,
  type SyncJwtClaims,
} from './sync-jwt.js';
import { timingSafeTokenEquals } from './platform-token.js';
import type { PlatformDB } from './db.js';
import {
  getActiveUserMachineByClerkId,
  getActiveUserMachineByHandle,
  getRunningUserMachineByClerkId,
  getContainer,
  getContainerByClerkId,
} from './db.js';
import type { ClerkAuth } from './clerk-auth.js';
import { approvalPage, approvalSuccessPage } from './device-approval-page.js';

function isSyncJwtConfigError(err: unknown): boolean {
  return err instanceof Error && (
    err.message === 'verifySyncJwt requires either secret or publicKey' ||
    err.message.includes('PLATFORM_JWT_SECRET must be at least 32 characters')
  );
}

const DEVICE_BODY_LIMIT = 4096;
const DEVICE_EXPIRES_IN_SEC = 2700;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_MAX_KEYS = 10_000;

export interface AuthRoutesConfig {
  db: PlatformDB;
  clerkAuth?: ClerkAuth;
  jwtSecret: string;
  platformUrl: string; // e.g. https://platform.matrix-os.com
  gatewayUrlForHandle: (handle: string) => string;
  ignoreLegacyContainers?: boolean;
  // Optional non-secret display profile (name/avatar) for the signing-in
  // client. Must NEVER throw or block token issuance — return null on any
  // failure (the avatar is a nice-to-have, the token is not).
  fetchUserProfile?: (clerkUserId: string) => Promise<DeviceProfile | null>;
  captureEvent?: (
    event: string,
    properties: Record<string, string | number | boolean | null | undefined>,
  ) => void;
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
  return timingSafeTokenEquals(cookieValue, formValue);
}

function readCsrfCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)device_csrf=([^;]+)/);
  return m ? m[1] : null;
}

function signNativeRedirectUri(secret: string, userCode: string, redirectUri: string): string {
  return createHmac('sha256', secret)
    .update(normalizeUserCode(userCode))
    .update('\0')
    .update(redirectUri)
    .digest('base64url');
}

function verifiedNativeRedirectUri(
  secret: string,
  userCode: string,
  redirectUriValue: unknown,
  signatureValue: unknown,
): string | null {
  const redirectUri = normalizeNativeRedirectUri(redirectUriValue);
  if (!redirectUri || typeof signatureValue !== 'string' || signatureValue.length > 128) {
    return null;
  }
  const expected = signNativeRedirectUri(secret, userCode, redirectUri);
  return timingSafeTokenEquals(expected, signatureValue) ? redirectUri : null;
}

function isTrustedNativeDesktopClient(clientId: unknown): boolean {
  return clientId === 'matrix-os-macos' || clientId === 'matrix-os-desktop';
}

function normalizeNativeRedirectUri(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'matrixos:' && url.hostname === 'auth') return url.toString();
    if (url.protocol === 'matrix-os:' && url.hostname === 'device-auth' && url.search === '') {
      return url.toString();
    }
    return null;
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.error(
        '[device-flow] Native redirect URI parse failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}

function applyNoFrameHeaders(
  c: import('hono').Context,
  scriptNonce?: string,
  options: { allowClerkCaptcha?: boolean } = {},
): void {
  c.header('X-Frame-Options', 'DENY');
  const scriptSrc = scriptNonce
    ? `'self' 'nonce-${scriptNonce}' https://clerk.matrix-os.com`
    : `'self' https://clerk.matrix-os.com`;
  const captchaSrc = options.allowClerkCaptcha
    ? ' https://challenges.cloudflare.com'
    : '';
  const captchaDirectives = options.allowClerkCaptcha
    ? " worker-src 'self' blob:; frame-src https://challenges.cloudflare.com;"
    : '';
  c.header(
    'Content-Security-Policy',
    `frame-ancestors 'none'; script-src ${scriptSrc}${captchaSrc};${captchaDirectives} object-src 'none'; base-uri 'none'`,
  );
}

function logDeviceApprovalAuthFailure(
  c: import('hono').Context,
  reason: string,
  tokenPresent: boolean,
  clerkVerified?: boolean,
): void {
  console.warn('[device/approve] auth failed:', {
    reason,
    authHeaderPresent: Boolean(c.req.header('authorization')),
    cookieHeaderPresent: Boolean(c.req.header('cookie')),
    tokenPresent,
    clerkVerified,
  });
}

export function createAuthRoutes(config: AuthRoutesConfig): Hono {
  const app = new Hono();
  const rateLimit = createRateLimiter();

  function captureAuthEvent(
    event: string,
    properties: Record<string, string | number | boolean | null | undefined> = {},
  ) {
    config.captureEvent?.(event, {
      source: "platform-device-auth",
      shell_surface: "cli_tui",
      ...properties,
    });
  }

  const flow: DeviceFlow = createDeviceFlow({
    db: config.db,
    verificationBase: config.platformUrl,
    expiresInSec: DEVICE_EXPIRES_IN_SEC,
    now: config.now,
    issueToken: async ({ clerkUserId, runtimeSlot }) => {
      const container = config.ignoreLegacyContainers || runtimeSlot
        ? undefined
        : await getContainerByClerkId(config.db, clerkUserId);
      const machine = container
        ? undefined
        : runtimeSlot
          ? await getRunningUserMachineByClerkId(config.db, clerkUserId, runtimeSlot)
          : await getActiveUserMachineByClerkId(config.db, clerkUserId);
      const handle = container?.handle ?? machine?.handle;
      if (!handle) {
        throw new Error('No runtime provisioned for this Clerk user');
      }
      const gatewayUrl = config.gatewayUrlForHandle(handle);
      const issued = await issueSyncJwt({
        secret: config.jwtSecret,
        clerkUserId,
        handle,
        gatewayUrl,
        runtimeSlot: machine?.runtimeSlot,
      });
      // Best-effort display profile; never let it break sign-in.
      let profile: DeviceProfile | null = null;
      if (config.fetchUserProfile) {
        try {
          profile = await config.fetchUserProfile(clerkUserId);
        } catch (err: unknown) {
          console.error(
            '[device/token] profile lookup failed:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      return {
        token: issued.token,
        expiresAt: issued.expiresAt,
        handle,
        ...(profile ? { profile } : {}),
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
      let body: { clientId?: unknown; redirectUri?: unknown };
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
        const nativeRedirectUri = normalizeNativeRedirectUri(body.redirectUri);
        const verificationUrl = new URL(issued.verificationUri);
        if (nativeRedirectUri && isTrustedNativeDesktopClient(body.clientId)) {
          verificationUrl.searchParams.set('redirect_uri', nativeRedirectUri);
          verificationUrl.searchParams.set(
            'redirect_sig',
            signNativeRedirectUri(config.jwtSecret, issued.userCode, nativeRedirectUri),
          );
        }
        captureAuthEvent("cli_device_code_created", {
          client_id: body.clientId,
        });
        return c.json({
          deviceCode: issued.deviceCode,
          userCode: issued.userCode,
          verificationUri: verificationUrl.toString(),
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
            captureAuthEvent("cli_device_token_expired");
            return c.json({ error: 'expired_token' }, 410);
          case 'approved':
            captureAuthEvent("cli_device_token_issued");
            return c.json({
              accessToken: result.token,
              expiresAt: result.expiresAt,
              userId: result.clerkUserId,
              handle: result.handle,
              ...(result.runtimeSlot ? { runtimeSlot: result.runtimeSlot } : {}),
              ...(result.profile?.displayName ? { displayName: result.profile.displayName } : {}),
              ...(result.profile?.imageUrl ? { imageUrl: result.profile.imageUrl } : {}),
              ...(result.profile?.email ? { email: result.profile.email } : {}),
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
    const nativeRedirectUri = verifiedNativeRedirectUri(
      config.jwtSecret,
      userCodeRaw,
      c.req.query('redirect_uri'),
      c.req.query('redirect_sig'),
    );
    const nativeRedirectSig = nativeRedirectUri ? c.req.query('redirect_sig') ?? null : null;
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
    applyNoFrameHeaders(c, scriptNonce, { allowClerkCaptcha: true });
    return c.html(approvalPage(
      userCodeRaw,
      csrf,
      publishableKey,
      scriptNonce,
      nativeRedirectUri,
      nativeRedirectSig,
    ));
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
        logDeviceApprovalAuthFailure(c, 'missing_token', false);
        return c.json({ error: 'unauthorized' }, 401);
      }
      const verifyResult = await config.clerkAuth.verify(token);
      if (!verifyResult.authenticated || !verifyResult.userId) {
        logDeviceApprovalAuthFailure(c, 'verify_failed', true, false);
        return c.json({ error: 'unauthorized' }, 401);
      }

      const cookieCsrf = readCsrfCookie(c.req.header('cookie'));
      let formCsrf: string | undefined;
      let userCode: string | undefined;
      let formRedirectUri: unknown;
      let formRedirectSig: unknown;
      let formRuntimeSlot: unknown;
      let nativeRedirectUri: string | null = null;
      try {
        const form = await c.req.parseBody();
        formCsrf = typeof form.csrf === 'string' ? form.csrf : undefined;
        userCode = typeof form.userCode === 'string' ? form.userCode : undefined;
        formRedirectUri = form.redirectUri;
        formRedirectSig = form.redirectSig;
        formRuntimeSlot = form.runtimeSlot;
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
      nativeRedirectUri = verifiedNativeRedirectUri(
        config.jwtSecret,
        userCode,
        formRedirectUri,
        formRedirectSig,
      );
      const parsedRuntimeSlot = formRuntimeSlot === undefined || formRuntimeSlot === ''
        ? { success: true as const, data: undefined }
        : MatrixComputerRuntimeSlotSchema.safeParse(formRuntimeSlot);
      if (!parsedRuntimeSlot.success) {
        return c.json({ error: 'invalid_request' }, 400);
      }

      try {
        if (parsedRuntimeSlot.data) {
          const selectedMachine = await getRunningUserMachineByClerkId(
            config.db,
            verifyResult.userId,
            parsedRuntimeSlot.data,
          );
          if (!selectedMachine) {
            return c.json({ error: 'computer_unavailable' }, 404);
          }
        }
        await flow.approveDeviceCode(userCode, verifyResult.userId, parsedRuntimeSlot.data);
        captureAuthEvent("cli_device_approved");
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'approval failed';
        console.error('[device/approve] failed:', msg);
        if (/expired/i.test(msg)) return c.json({ error: 'expired_token' }, 410);
        if (/unknown/i.test(msg)) return c.json({ error: 'invalid_user_code' }, 404);
        return c.json({ error: 'server_error' }, 500);
      }

      applyNoFrameHeaders(c);
      return c.html(approvalSuccessPage(nativeRedirectUri));
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
    const container = claims.runtime_slot
      ? undefined
      : await getContainer(config.db, claims.handle);
    const machine = container
      ? undefined
      : await getActiveUserMachineByHandle(config.db, claims.handle, claims.runtime_slot);
    const ownerClerkUserId = container?.clerkUserId ?? machine?.clerkUserId;
    const handle = container?.handle ?? machine?.handle;
    if (!ownerClerkUserId || !handle) {
      captureAuthEvent("cli_runtime_lookup_missing");
      return c.json({ error: 'unknown_handle' }, 404);
    }
    if (ownerClerkUserId !== claims.sub) {
      captureAuthEvent("cli_runtime_lookup_unauthorized");
      return c.json({ error: 'unauthorized' }, 401);
    }
    captureAuthEvent("cli_runtime_lookup_resolved");
    return c.json({
      userId: claims.sub,
      handle,
      ...(machine?.runtimeSlot ? { runtimeSlot: machine.runtimeSlot } : {}),
      gatewayUrl: config.gatewayUrlForHandle(handle),
    });
  });

  return app;
}
