import { createHmac, randomBytes } from 'node:crypto';
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
import { timingSafeTokenEquals } from './platform-token.js';
import type { PlatformDB } from './db.js';
import {
  getActiveUserMachineByClerkId,
  getActiveUserMachineByHandle,
  getContainer,
  getContainerByClerkId,
} from './db.js';
import type { ClerkAuth } from './clerk-auth.js';

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
  nativeRedirectUri: string | null,
  nativeRedirectSig: string | null,
): string {
  // Renders an HTML page that lets a Clerk-authenticated user confirm the
  // device pairing. The Clerk widget is loaded for sign-in if needed; once a
  // session exists, JS sends an explicit bearer token to /auth/device/approve.
  // The CSRF value is also written as a cookie via Set-Cookie on this response
  // so POST /auth/device/approve can verify the double-submit.
  const escapedCode = userCode.replace(/[^A-Z0-9-]/gi, '');
  const escapedCsrf = csrf.replace(/[^a-f0-9]/gi, '');
  const escapedPublishableKey = publishableKey
    ? escapeHtmlAttr(publishableKey)
    : null;
  const escapedNativeRedirectUri = nativeRedirectUri ? escapeHtmlAttr(nativeRedirectUri) : '';
  const escapedNativeRedirectSig = nativeRedirectSig ? escapeHtmlAttr(nativeRedirectSig) : '';
  const isNativeApp = Boolean(nativeRedirectUri);
  const productLabel = isNativeApp ? 'Matrix OS app' : 'Matrix CLI';
  const setupTitle = isNativeApp ? 'Checking Matrix OS' : 'Setting up Matrix CLI';
  const recoveryDetail = isNativeApp
    ? 'Matrix could not finish connecting the desktop app. Try again after a moment.'
    : 'Matrix could not finish connecting this terminal. Try again after a moment.';
  const clerkScript = publishableKey
    ? `
  <script nonce="${scriptNonce}">
    var userCode = "${escapedCode}";
    var csrf = "${escapedCsrf}";
    var approvalUrl = window.location.href;
    var authMode = new URL(window.location.href).searchParams.get('mode') === 'sign-in' ? 'sign-in' : 'sign-up';
    var nativeApp = ${isNativeApp ? 'true' : 'false'};
    var runtimeReady = false;

    function deviceReturnPath() {
      var url = new URL(window.location.href);
      url.searchParams.delete('billing');
      url.searchParams.delete('checkout');
      return url.pathname + url.search;
    }

    function billingSetupPath() {
      var url = new URL('/', window.location.origin);
      url.searchParams.set('device_return', deviceReturnPath());
      return url.pathname + url.search;
    }

    function redirectToBillingSetup() {
      window.location.assign(billingSetupPath());
    }

    function deviceAuthUrl(mode) {
      var url = new URL(approvalUrl);
      url.searchParams.delete('billing');
      url.searchParams.delete('checkout');
      url.searchParams.set('mode', mode);
      return url.toString();
    }

    function fetchWithTimeout(url, options) {
      var controller = new AbortController();
      var timeoutId = window.setTimeout(function() { controller.abort(); }, 10000);
      return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(function() {
        window.clearTimeout(timeoutId);
      });
    }

    function setStatus(message) {
      var status = document.getElementById('status');
      if (status) status.textContent = message;
    }

    function setBusy(isBusy) {
      var button = document.getElementById('confirm-button');
      if (button) {
        button.disabled = isBusy || !runtimeReady;
        button.textContent = isBusy ? 'authorizing...' : 'approve login';
      }
    }

    function setConfirmReady(isReady) {
      var form = document.getElementById('confirm-area');
      var confirm = document.getElementById('confirm-button');
      if (form) form.style.display = isReady ? 'block' : 'none';
      if (confirm) {
        confirm.disabled = true;
        if (isReady) confirm.disabled = false;
      }
    }

    function updateSignedInInstance() {
      var instance = document.getElementById('instance-line');
      if (!instance || !window.Clerk || !window.Clerk.user) return;
      var user = window.Clerk.user;
      var handle = user.username || user.primaryEmailAddress?.emailAddress || user.id;
      instance.textContent = 'signed in: @' + handle + ' on app.matrix-os.com';
    }

    function renderActionState(title, detail, primaryLabel, primaryHandler) {
      var signin = document.getElementById('signin-area');
      if (!signin) return;
      signin.style.display = 'block';
      signin.innerHTML = '';
      delete signin.dataset.mounted;
      var state = document.createElement('div');
      state.className = 'device-state';
      var heading = document.createElement('h2');
      heading.textContent = title;
      state.appendChild(heading);
      var copy = document.createElement('p');
      copy.textContent = detail;
      state.appendChild(copy);
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = primaryLabel;
      button.addEventListener('click', primaryHandler);
      state.appendChild(button);
      signin.appendChild(state);
    }

    function showLoadingState(message) {
      setConfirmReady(false);
      renderActionState('${setupTitle}', message, 'Working...', function() {});
      var button = document.querySelector('#signin-area button');
      if (button) button.disabled = true;
    }

    function showRuntimeSetupState() {
      runtimeReady = false;
      setConfirmReady(false);
      renderActionState(
        'Set up your Matrix computer',
        'Create or activate your Matrix computer first, then return here to approve the desktop app.',
        'Open setup',
        redirectToBillingSetup
      );
    }

    function showSignedInRecoveryState() {
      runtimeReady = false;
      setConfirmReady(false);
      renderActionState(
        'Session needs a refresh',
        '${recoveryDetail}',
        'Try again',
        continueDeviceOnboarding
      );
    }

    function showConfirm() {
      runtimeReady = true;
      var signin = document.getElementById('signin-area');
      if (signin) {
        signin.style.display = 'none';
        signin.innerHTML = '';
      }
      setStatus('');
      setConfirmReady(true);
    }

    function showSignUp() {
      runtimeReady = false;
      setConfirmReady(false);
      var signin = document.getElementById('signin-area');
      if (signin) signin.style.display = 'block';
      if (signin && !signin.dataset.mounted) {
        signin.dataset.mounted = 'true';
        window.Clerk.mountSignUp(signin, {
          signInUrl: deviceAuthUrl('sign-in'),
          forceRedirectUrl: approvalUrl,
          fallbackRedirectUrl: approvalUrl,
          signInForceRedirectUrl: approvalUrl,
          signInFallbackRedirectUrl: approvalUrl,
          oauthFlow: 'redirect',
        });
      }
    }

    function showSignIn() {
      runtimeReady = false;
      setConfirmReady(false);
      var signin = document.getElementById('signin-area');
      if (signin) signin.style.display = 'block';
      if (signin && !signin.dataset.mounted) {
        signin.dataset.mounted = 'true';
        window.Clerk.mountSignIn(signin, {
          signUpUrl: deviceAuthUrl('sign-up'),
          forceRedirectUrl: approvalUrl,
          fallbackRedirectUrl: approvalUrl,
          signUpForceRedirectUrl: approvalUrl,
          signUpFallbackRedirectUrl: approvalUrl,
          oauthFlow: 'redirect',
        });
      }
    }

    function showAuth() {
      if (authMode === 'sign-in') {
        showSignIn();
        return;
      }
      showSignUp();
    }

    async function clerkTokenOrNull() {
      if (!window.Clerk || !window.Clerk.session) return null;
      return await window.Clerk.session.getToken();
    }

    async function continueDeviceOnboarding() {
      try {
        var token = await clerkTokenOrNull();
        if (!token) {
          showAuth();
          return;
        }
        showLoadingState('Checking your Matrix computer...');
        var res = await fetchWithTimeout('/api/auth/app-session', {
          method: 'POST',
          headers: {
            Authorization: \`Bearer \${token}\`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ redirectTo: deviceReturnPath() }),
          credentials: 'same-origin',
        });
        if (res.ok) {
          showConfirm();
          return;
        }
        if (res.status === 404) {
          if (nativeApp) {
            showRuntimeSetupState();
            return;
          }
          redirectToBillingSetup();
          return;
        }
        showSignedInRecoveryState();
      } catch (err) {
        console.error('[matrix] Device session exchange failed', err instanceof Error ? err.message : String(err));
        showSignedInRecoveryState();
      }
    }

    async function submitApproval(event) {
      if (!window.Clerk) return;
      event.preventDefault();
      setStatus('');
      setBusy(true);

      try {
        if (!runtimeReady) {
          await continueDeviceOnboarding();
          return;
        }

        var token = await clerkTokenOrNull();
        if (!token) {
          showAuth();
          return;
        }

        var body = new URLSearchParams({ userCode: userCode, csrf: csrf });
        var nativeRedirectUri = document.getElementById('native-redirect-uri')?.value || '';
        var nativeRedirectSig = document.getElementById('native-redirect-sig')?.value || '';
        if (nativeRedirectUri) body.set('redirectUri', nativeRedirectUri);
        if (nativeRedirectSig) body.set('redirectSig', nativeRedirectSig);
        var res = await fetchWithTimeout('/auth/device/approve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: \`Bearer \${token}\`,
          },
          body: body,
          credentials: 'same-origin',
        });

        if (res.ok) {
          var html = await res.text();
          document.open();
          document.write(html);
          document.close();
          return;
        }

        setStatus('Could not authorize this device. Refresh and try again.');
      } catch (err) {
        console.error('[matrix] Device approval failed', err instanceof Error ? err.message : String(err));
        setStatus('Could not authorize this device. Refresh and try again.');
      } finally {
        setBusy(false);
      }
    }

    function initClerk() {
      window.Clerk.load().then(function() {
        updateSignedInInstance();
        if (window.Clerk.user && window.Clerk.session) {
          continueDeviceOnboarding();
        } else {
          showAuth();
        }
      }).catch(function() {
        setStatus('Could not load signup. Refresh and try again.');
      });
    }

    document.addEventListener('DOMContentLoaded', function() {
      var form = document.getElementById('confirm-area');
      var clerkScript = document.getElementById('clerk-script');
      if (form) form.addEventListener('submit', submitApproval);
      if (window.Clerk) {
        initClerk();
      } else if (clerkScript) {
        clerkScript.addEventListener('load', initClerk);
        clerkScript.addEventListener('error', function() {
          setStatus('Could not load sign-in. Refresh and try again.');
        });
      }
    });
  </script>`
    : '';
  const clerkLoader = publishableKey
    ? `
  <script
    id="clerk-script"
    nonce="${scriptNonce}"
    async crossorigin="anonymous"
    data-clerk-publishable-key="${escapedPublishableKey}"
    src="https://clerk.matrix-os.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize device -- Matrix OS</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #101312;
      color: #e8efe7;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 24px;
    }
    main {
      width: min(1120px, 100%);
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(360px, 440px);
      gap: 24px;
      align-items: stretch;
    }
    .terminal {
      min-height: 480px;
      background: #070908;
      border: 1px solid #2b3a34;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 24px 80px rgba(0,0,0,0.38);
    }
    .bar {
      height: 38px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 14px;
      background: #151a18;
      border-bottom: 1px solid #2b3a34;
      color: #9aa8a1;
      font-size: 13px;
    }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: #5f6b65; }
    .dot.ok { background: #66d19e; }
    .screen {
      padding: 28px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 14px;
      line-height: 1.7;
    }
    .prompt { color: #8fbfa3; }
    .muted { color: #8a968f; }
    .code {
      display: inline-block;
      margin: 12px 0 18px;
      padding: 10px 14px;
      border: 1px solid #385247;
      border-radius: 6px;
      background: #101714;
      color: #f4f7f1;
      font-size: 24px;
      letter-spacing: 0.08em;
    }
    .panel {
      background: #f6f2e8;
      color: #25332d;
      border: 1px solid #ddd4c3;
      border-radius: 8px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    h1 { margin: 0; font-size: 20px; line-height: 1.2; }
    h2 { margin: 0; font-size: 18px; line-height: 1.2; }
    p { margin: 0; color: #516158; line-height: 1.5; }
    button {
      width: 100%;
      background: #25332d;
      color: #fffdf6;
      border: 0;
      padding: 0.75rem 1rem;
      font-size: 0.95rem;
      border-radius: 6px;
      cursor: pointer;
    }
    button:disabled { opacity: 0.65; cursor: wait; }
    .status { min-height: 1.25rem; color: #9f2d2d; }
    #signin-area { min-width: 0; }
    .device-state {
      display: flex;
      flex-direction: column;
      gap: 12px;
      border-top: 1px solid #ded7c9;
      padding-top: 16px;
    }
    @media (max-width: 760px) {
      main { grid-template-columns: 1fr; }
      .terminal { min-height: 360px; }
      .screen { padding: 20px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="terminal" aria-label="${productLabel} login preview">
      <div class="bar"><span class="dot ok"></span><span class="dot"></span><span class="dot"></span><span>${isNativeApp ? 'matrix app sign in' : 'matrix login'}</span></div>
      <div class="screen">
        <div><span class="prompt">matrix</span> login</div>
        <div class="muted">open app.matrix-os.com/auth/device</div>
        <div>verification code</div>
        <div class="code">${escapedCode}</div>
        <div id="instance-line" class="muted">waiting for signed-in Matrix instance...</div>
        <br>
        <div><span class="prompt">matrix</span> whoami</div>
        <div class="muted">@handle on app.matrix-os.com</div>
        <div><span class="prompt">matrix</span> shell attach -c main</div>
        <div><span class="prompt">matrix</span> run -it -- claude</div>
        <div><span class="prompt">matrix</span> doctor</div>
      </div>
    </section>
    <section class="panel">
      <div>
        <h1>Approve ${productLabel}</h1>
        <p>Authorize ${isNativeApp ? 'the desktop app' : 'this terminal'} to connect to your Matrix OS cloud computer.</p>
      </div>
      <div id="signin-area" style="display:none"></div>
      <form id="confirm-area" method="POST" action="/auth/device/approve" style="display:none">
        <input type="hidden" name="userCode" value="${escapedCode}">
        <input type="hidden" name="csrf" value="${escapedCsrf}">
        <input id="native-redirect-uri" type="hidden" name="redirectUri" value="${escapedNativeRedirectUri}">
        <input id="native-redirect-sig" type="hidden" name="redirectSig" value="${escapedNativeRedirectSig}">
        <button id="confirm-button" type="submit" disabled>approve login</button>
      </form>
      <p id="status" class="status" role="status" aria-live="polite">${publishableKey ? '' : 'Sign-in is unavailable. Refresh and try again.'}</p>
    </section>
  </main>
  ${clerkLoader}
  ${clerkScript}
</body>
</html>`;
}

function approvalSuccessPage(nativeRedirectUri: string | null = null): string {
  const redirectMeta = nativeRedirectUri
    ? `<meta http-equiv="refresh" content="0; url=${escapeHtmlAttr(nativeRedirectUri)}">`
    : '';
  const redirectLink = nativeRedirectUri
    ? `<p><a href="${escapeHtmlAttr(nativeRedirectUri)}">Return to Matrix OS</a></p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">${redirectMeta}<title>Authorized</title>
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#eee;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{max-width:380px;padding:2rem;background:#141414;border:1px solid #222;border-radius:8px;text-align:center}</style></head>
<body><div class="card"><h1>Login successful</h1><p>You can close this tab and return to Matrix OS.</p>${redirectLink}</div></body></html>`;
}

function normalizeNativeRedirectUri(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'matrixos:' || url.hostname !== 'auth') return null;
    return url.toString();
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
    issueToken: async ({ clerkUserId }) => {
      const container = await getContainerByClerkId(config.db, clerkUserId);
      const machine = container ? undefined : await getActiveUserMachineByClerkId(config.db, clerkUserId);
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
      });
      return {
        token: issued.token,
        expiresAt: issued.expiresAt,
        handle,
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
        if (nativeRedirectUri && body.clientId === 'matrix-os-macos') {
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
      let nativeRedirectUri: string | null = null;
      try {
        const form = await c.req.parseBody();
        formCsrf = typeof form.csrf === 'string' ? form.csrf : undefined;
        userCode = typeof form.userCode === 'string' ? form.userCode : undefined;
        formRedirectUri = form.redirectUri;
        formRedirectSig = form.redirectSig;
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

      try {
        await flow.approveDeviceCode(userCode, verifyResult.userId);
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
    const container = await getContainer(config.db, claims.handle);
    const machine = container ? undefined : await getActiveUserMachineByHandle(config.db, claims.handle);
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
      gatewayUrl: config.gatewayUrlForHandle(handle),
    });
  });

  return app;
}
