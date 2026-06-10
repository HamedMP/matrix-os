import type { UserMachineRecord } from './db.js';
import { normalizeDeviceReturnPath } from './request-routing.js';

export const CLERK_SCRIPT_ORIGIN = 'https://clerk.matrix-os.com';
const BROWSER_CLERK_SIGN_OUT_TIMEOUT_MS = 10_000;

function deviceReturnTargetFromRedirectPath(redirectTarget: string): string {
  try {
    const url = new URL(redirectTarget, 'https://app.matrix-os.com');
    return normalizeDeviceReturnPath(url.searchParams.get('device_return')) ?? '';
  } catch (err: unknown) {
    console.warn('[platform] Failed to extract device return target:', err instanceof Error ? err.message : String(err));
    return '';
  }
}

export function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

export function escapeHtml(value: string): string {
  return escapeHtmlAttr(value);
}

export function escapeInlineScriptJson(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export function getAuthPage(
  publishableKey: string,
  mode: 'sign-in' | 'sign-up',
  scriptNonce: string,
  redirectTarget: string,
) {
  const escapedPublishableKey = escapeHtmlAttr(publishableKey);
  const redirectTargetJson = escapeInlineScriptJson(redirectTarget);
  const deviceReturnTargetJson = escapeInlineScriptJson(deviceReturnTargetFromRedirectPath(redirectTarget));
  const signOutTargetJson = escapeInlineScriptJson(mode === 'sign-up' ? '/sign-up' : '/sign-in');
  const modeLabel = mode === 'sign-up' ? 'Create your free Matrix account' : 'Welcome back to Matrix';
  const modeDetail = mode === 'sign-up'
    ? 'Start with a free account. The 3-day hosted Matrix trial begins only when you provision your cloud computer.'
    : 'Sign in to continue to your Matrix computer, provisioning status, or trial checkout.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Matrix OS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      background: #E2E2CF;
      color: #32352E;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .page {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(420px, 0.95fr);
    }
    .story {
      position: relative;
      display: flex;
      align-items: center;
      overflow: hidden;
      border-right: 1px solid #D6D3C8;
      background: #E0E1CA;
      padding: 64px;
    }
    .story::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(ellipse at 24% 20%, rgba(250,250,245,0.78) 0%, transparent 55%),
        radial-gradient(ellipse at 82% 72%, rgba(208,111,37,0.12) 0%, transparent 60%);
    }
    .story::after {
      content: "";
      position: absolute;
      inset: 0;
      opacity: 0.08;
      background-image:
        linear-gradient(rgba(67,78,63,0.28) 1px, transparent 1px),
        linear-gradient(90deg, rgba(67,78,63,0.28) 1px, transparent 1px);
      background-size: 42px 42px;
    }
    .story-inner { position: relative; z-index: 1; max-width: 560px; }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 48px;
      color: #434E3F;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .logo {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border-radius: 12px;
      background: rgba(250,250,245,0.58);
      border: 1px solid rgba(67,78,63,0.14);
      color: #D06F25;
    }
    .eyebrow {
      margin-bottom: 18px;
      color: #7A7768;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.28em;
      text-transform: uppercase;
    }
    h1 {
      max-width: 560px;
      color: #434E3F;
      font-size: clamp(2.4rem, 6vw, 4.8rem);
      line-height: 0.98;
      letter-spacing: -0.04em;
      font-weight: 750;
      margin-bottom: 24px;
    }
    .lead {
      max-width: 500px;
      color: #5C5A4F;
      font-size: 16px;
      line-height: 1.8;
    }
    .proof {
      display: grid;
      gap: 12px;
      margin-top: 38px;
    }
    .proof-row {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      color: #5C5A4F;
      font-size: 13px;
      line-height: 1.55;
    }
    .dot {
      width: 9px;
      height: 9px;
      margin-top: 5px;
      border-radius: 999px;
      background: #D06F25;
      box-shadow: 0 0 0 5px rgba(208,111,37,0.12);
      flex: none;
    }
    .auth-panel {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px;
    }
    .auth-card {
      width: 100%;
      max-width: 390px;
      min-height: 470px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid #D6D3C8;
      border-radius: 24px;
      background: rgba(250,250,245,0.68);
      box-shadow: 0 24px 80px rgba(50,53,46,0.12);
      padding: 32px;
      backdrop-filter: blur(14px);
    }
    #auth { width: 100%; min-height: 400px; display: flex; align-items: center; justify-content: center; }
    .loading { color: #7A7768; font-size: 14px; }
    .session-state {
      display: grid;
      gap: 16px;
      width: 100%;
      color: #32352E;
      text-align: left;
    }
    .session-state h2 {
      margin: 0;
      color: #434E3F;
      font-size: 24px;
      line-height: 1.12;
    }
    .session-state p {
      margin: 0;
      color: #5C5A4F;
      font-size: 14px;
      line-height: 1.6;
    }
    .session-actions {
      display: grid;
      gap: 10px;
      margin-top: 4px;
    }
    .session-actions button {
      width: 100%;
      min-height: 44px;
      border: 1px solid #C9C4B8;
      border-radius: 14px;
      background: rgba(250,250,245,0.76);
      color: #32352E;
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      font-weight: 650;
    }
    .session-actions button.primary {
      border-color: #D06F25;
      background: #D06F25;
      color: #fffdf6;
    }
    @media (max-width: 860px) {
      .page { grid-template-columns: 1fr; }
      .story { min-height: 42vh; border-right: 0; border-bottom: 1px solid #D6D3C8; padding: 40px 24px; }
      .auth-panel { padding: 28px 20px 44px; }
      .auth-card { max-width: 440px; padding: 24px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="story">
      <div class="story-inner">
        <div class="brand"><span class="logo">M</span><span>Matrix OS</span></div>
        <p class="eyebrow">${mode === 'sign-up' ? 'Free account' : 'Secure access'}</p>
        <h1>${modeLabel}</h1>
        <p class="lead">${modeDetail}</p>
        <div class="proof">
          <div class="proof-row"><span class="dot"></span><span>Signup stays free until you deliberately start hosted provisioning.</span></div>
          <div class="proof-row"><span class="dot"></span><span>The trial provisions an owner-controlled Matrix computer, not just a dashboard.</span></div>
          <div class="proof-row"><span class="dot"></span><span>Clerk handles account security and the payment step for the hosted runtime.</span></div>
        </div>
      </div>
    </section>
    <section class="auth-panel">
      <div class="auth-card">
        <div id="auth"><span class="loading">Loading...</span></div>
      </div>
    </section>
  </main>
  <script
    id="clerk-script"
    nonce="${scriptNonce}"
    async
    crossorigin="anonymous"
    data-clerk-publishable-key="${escapedPublishableKey}"
    src="${CLERK_SCRIPT_ORIGIN}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
    type="text/javascript"
  ></script>
  <script nonce="${scriptNonce}">
    var redirectTarget = ${redirectTargetJson};
    var deviceReturnTarget = ${deviceReturnTargetJson};
    var signOutTarget = ${signOutTargetJson};
    var SIGN_OUT_TIMEOUT_MS = ${BROWSER_CLERK_SIGN_OUT_TIMEOUT_MS};
    var requestedRuntime = new URLSearchParams(redirectTarget.split('?')[1] || '').get('runtime');
    var checkoutAttemptStorageKey = 'matrix.billing.checkoutAttemptAt';
    var checkoutAttemptMaxAgeMs = 30 * 60 * 1000;
    function hasTrustedCheckoutReturn() {
      try {
        var rawAttemptAt = window.sessionStorage.getItem(checkoutAttemptStorageKey);
        if (!rawAttemptAt) return false;
        var attemptAt = Number(rawAttemptAt);
        return Number.isFinite(attemptAt) && Date.now() - attemptAt <= checkoutAttemptMaxAgeMs;
      } catch (err) {
        console.warn('[matrix] Unable to read checkout attempt state', err instanceof Error ? err.message : String(err));
        return false;
      }
    }
    function stripCheckoutReturnParams() {
      try {
        var currentUrl = new URL(window.location.href);
        currentUrl.searchParams.delete('checkout');
        if (currentUrl.searchParams.get('billing') === 'success') currentUrl.searchParams.delete('billing');
        window.history.replaceState(null, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
      } catch (err) {
        console.warn('[matrix] Unable to clear checkout return state', err instanceof Error ? err.message : String(err));
      }
    }
    var checkoutReturnRequested = new URLSearchParams(window.location.search || '').get('checkout') === 'success';
    var checkoutJustCompleted = checkoutReturnRequested && hasTrustedCheckoutReturn();
    if (checkoutReturnRequested) stripCheckoutReturnParams();
    var provisionStarted = false;
    var provisioningPolls = 0;
    var maxProvisioningPolls = 60;
    var billingConfirmationPolls = 0;
    var maxBillingConfirmationPolls = 60;
    var appearance = {
      variables: {
        colorPrimary: '#D06F25',
        colorBackground: 'transparent',
        colorText: '#32352E',
        colorTextSecondary: '#5C5A4F',
        colorInputBackground: 'rgba(250,250,245,0.74)',
        colorInputText: '#32352E',
        borderRadius: '0.875rem',
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      },
      layout: {
        socialButtonsPlacement: 'top',
        socialButtonsVariant: 'blockButton',
        logoLinkUrl: 'https://matrix-os.com'
      },
      elements: {
        card: 'border-0 bg-transparent shadow-none p-0',
        header: 'text-left',
        formButtonPrimary: 'shadow-none',
        footerActionLink: 'font-medium'
      }
    };
    function clerkSignOutWithTimeout() {
      var timeoutId;
      return Promise.race([
        Promise.resolve(window.Clerk.signOut({ redirectUrl: signOutTarget })),
        new Promise(function(_, reject) {
          timeoutId = window.setTimeout(function() {
            var err = new Error('Clerk sign-out timed out');
            err.name = 'TimeoutError';
            reject(err);
          }, SIGN_OUT_TIMEOUT_MS);
        })
      ]).finally(function() {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      });
    }
    function redirectAfterSignOutIssue(err) {
      console.warn('[matrix] Clerk.signOut did not finish', err instanceof Error ? err.name : String(typeof err));
      window.location.replace(signOutTarget);
    }
    function renderSessionState(title, detail, primaryLabel, primaryHandler) {
      var el = document.getElementById('auth');
      el.innerHTML = '';

      var state = document.createElement('div');
      state.className = 'session-state';

      var heading = document.createElement('h2');
      heading.textContent = title;
      state.appendChild(heading);

      var detailText = document.createElement('p');
      detailText.textContent = detail;
      state.appendChild(detailText);

      var actions = document.createElement('div');
      actions.className = 'session-actions';

      var continueButton = document.createElement('button');
      continueButton.type = 'button';
      continueButton.className = 'primary';
      continueButton.textContent = primaryLabel;
      continueButton.addEventListener('click', primaryHandler);
      actions.appendChild(continueButton);

      var signOutButton = document.createElement('button');
      signOutButton.type = 'button';
      signOutButton.textContent = 'Sign out';
      signOutButton.addEventListener('click', function() {
        signOutButton.disabled = true;
        signOutButton.textContent = 'Signing out...';
        fetch('/api/auth/app-session', {
          method: 'DELETE',
          credentials: 'same-origin'
        })
          .catch(function(err) {
            console.error('[matrix] App session clear failed', err instanceof Error ? err.message : String(err));
          })
          .then(function() {
            return clerkSignOutWithTimeout();
          })
          .then(function() {
            window.location.replace(signOutTarget);
          })
          .catch(redirectAfterSignOutIssue);
      });
      actions.appendChild(signOutButton);

      state.appendChild(actions);
      el.appendChild(state);
    }
    function showLoadingState(message) {
      var el = document.getElementById('auth');
      el.innerHTML = '';
      var loading = document.createElement('span');
      loading.className = 'loading';
      loading.textContent = message;
      el.appendChild(loading);
    }
    function showSignedInRecoveryState() {
      renderSessionState(
        'Session needs a refresh',
        'Matrix could not connect your browser session to a Matrix computer. Try again, or sign out if you are testing a different account.',
        'Try again',
        continueWithClerkSession
      );
    }
    function showNoRuntimeState() {
      renderSessionState(
        'No Matrix computer is attached',
        'This account is signed in, but Matrix could not find an attached cloud computer yet.',
        'Provision Matrix computer',
        startProvisioningFromClerkSession
      );
    }
    function showBillingRequiredState() {
      showLoadingState('Opening Billing settings...');
      openBillingSettingsFromClerkSession();
    }
    var billingSetupRetryStorageKey = 'matrix.billing.setupRetryCount';
    var maxBillingSetupReloads = 3;
    function readBillingSetupRetryCount() {
      try {
        var raw = window.sessionStorage.getItem(billingSetupRetryStorageKey);
        var count = raw ? Number(raw) : 0;
        return Number.isFinite(count) && count > 0 ? count : 0;
      } catch (err) {
        console.warn('[matrix] Unable to read billing setup retry state', err instanceof Error ? err.message : String(err));
        return 0;
      }
    }
    function writeBillingSetupRetryCount(count) {
      try {
        window.sessionStorage.setItem(billingSetupRetryStorageKey, String(count));
      } catch (err) {
        console.warn('[matrix] Unable to write billing setup retry state', err instanceof Error ? err.message : String(err));
      }
    }
    function clearBillingSetupRetryCount() {
      try {
        window.sessionStorage.removeItem(billingSetupRetryStorageKey);
      } catch (err) {
        console.warn('[matrix] Unable to clear billing setup retry state', err instanceof Error ? err.message : String(err));
      }
    }
    function showBillingSetupRetryLimitState() {
      renderSessionState(
        'Billing settings are still loading',
        'Matrix is reconnecting the billing settings panel. Try again after a moment.',
        'Try again',
        function() {
          clearBillingSetupRetryCount();
          window.location.reload();
        }
      );
    }
    function billingSetupPath() {
      var url = new URL('/', window.location.origin);
      url.searchParams.set('billing', 'setup');
      if (deviceReturnTarget) url.searchParams.set('device_return', deviceReturnTarget);
      return url.pathname + url.search;
    }
    function openBillingSettingsFromClerkSession() {
      var target = billingSetupPath();
      if (window.location.pathname + window.location.search === target) {
        var retryCount = readBillingSetupRetryCount();
        if (retryCount >= maxBillingSetupReloads) {
          showBillingSetupRetryLimitState();
          return;
        }
        writeBillingSetupRetryCount(retryCount + 1);
        window.setTimeout(function() { window.location.reload(); }, 2000 + retryCount * 1000);
        return;
      }
      clearBillingSetupRetryCount();
      window.location.replace(target);
    }
    function showCheckoutUnavailableState() {
      renderSessionState(
        'Checkout unavailable',
        'Billing checkout is temporarily unavailable. Try again shortly.',
        'Try again',
        startBillingCheckoutFromClerkSession
      );
    }
    function rememberBillingCheckoutAttempt() {
      try {
        window.sessionStorage.setItem(checkoutAttemptStorageKey, String(Date.now()));
      } catch (err) {
        console.warn('[matrix] Unable to write checkout attempt state', err instanceof Error ? err.message : String(err));
      }
    }
    function startBillingCheckoutFromClerkSession() {
      showLoadingState('Opening secure checkout...');
      if (!window.Clerk.session) {
        showSignedInRecoveryState();
        return;
      }
      window.Clerk.session.getToken()
        .then(function(token) {
          if (!token) {
            showSignedInRecoveryState();
            return null;
          }
          var controller = new AbortController();
          var timeoutId = window.setTimeout(function() { controller.abort(); }, 10000);
          var checkoutBody = {
            planSlug: 'matrix_builder',
            interval: 'monthly',
            regionSlug: 'region_fsn1'
          };
          if (deviceReturnTarget) checkoutBody.returnPath = redirectTarget;
          return fetch('/billing/checkout', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify(checkoutBody),
            credentials: 'same-origin',
            signal: controller.signal
          }).finally(function() {
            window.clearTimeout(timeoutId);
          });
        })
        .then(function(res) {
          if (!res) return null;
          return res.json().catch(function(err) {
            console.warn('[matrix] Unable to parse checkout response', err instanceof Error ? err.message : String(err));
            return null;
          }).then(function(body) {
            if (!res.ok || !body || typeof body.url !== 'string') {
              showCheckoutUnavailableState();
              return;
            }
            rememberBillingCheckoutAttempt();
            window.location.assign(body.url);
          });
        })
        .catch(function(err) {
          console.error('[matrix] Billing checkout failed', err instanceof Error ? err.message : String(err));
          showCheckoutUnavailableState();
        });
    }
    function pollProvisioningSession() {
      provisioningPolls += 1;
      if (provisioningPolls > maxProvisioningPolls) {
        provisionStarted = false;
        checkoutJustCompleted = false;
        billingConfirmationPolls = 0;
        showSignedInRecoveryState();
        return;
      }
      window.setTimeout(continueWithClerkSession, 8000);
    }
    function retryProvisioningAfterBillingDelay() {
      billingConfirmationPolls += 1;
      if (billingConfirmationPolls > maxBillingConfirmationPolls) {
        provisionStarted = false;
        checkoutJustCompleted = false;
        showBillingRequiredState();
        return;
      }
      provisionStarted = false;
      showLoadingState('Confirming billing...');
      window.setTimeout(startProvisioningFromClerkSession, 8000);
    }
    function startProvisioningFromClerkSession() {
      if (provisionStarted) return;
      provisionStarted = true;
      showLoadingState('Starting your Matrix computer...');
      if (!window.Clerk.session) {
        provisionStarted = false;
        showSignedInRecoveryState();
        return;
      }
      window.Clerk.session.getToken()
        .then(function(token) {
          if (!token) {
            provisionStarted = false;
            showSignedInRecoveryState();
            return null;
          }
          var controller = new AbortController();
          var timeoutId = window.setTimeout(function() { controller.abort(); }, 10000);
          return fetch('/api/auth/provision-runtime', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              runtime: requestedRuntime || undefined
            }),
            credentials: 'same-origin',
            signal: controller.signal
          }).finally(function() {
            window.clearTimeout(timeoutId);
          });
        })
        .then(function(res) {
          if (!res) return null;
          if (res.ok) {
            billingConfirmationPolls = 0;
            provisioningPolls = 0;
            showLoadingState('Preparing your Matrix computer...');
            pollProvisioningSession();
            return null;
          }
          if (res.status === 402) {
            if (checkoutJustCompleted) {
              retryProvisioningAfterBillingDelay();
              return null;
            }
            provisionStarted = false;
            showBillingRequiredState();
            return null;
          }
          if (res.status === 409) {
            return res.json().catch(function(err) {
              console.warn('[matrix] Unable to parse provisioning conflict response', err instanceof Error ? err.message : String(err));
              return null;
            }).then(function(body) {
              if (body && body.code === 'provisioning_conflict') {
                billingConfirmationPolls = 0;
                provisioningPolls = 0;
                showLoadingState('Preparing your Matrix computer...');
                pollProvisioningSession();
                return;
              }
              checkoutJustCompleted = false;
              provisionStarted = false;
              showSignedInRecoveryState();
            });
          }
          provisionStarted = false;
          showSignedInRecoveryState();
          return null;
        })
        .catch(function(err) {
          console.error('[matrix] Runtime provisioning failed', err instanceof Error ? err.message : String(err));
          provisionStarted = false;
          showSignedInRecoveryState();
        });
    }
    function continueWithClerkSession() {
      showLoadingState('Loading your Matrix computer...');
      if (!window.Clerk.session) {
        showSignedInRecoveryState();
        return;
      }
      window.Clerk.session.getToken()
        .then(function(token) {
          if (!token) {
            showSignedInRecoveryState();
            return null;
          }
          return fetch('/api/auth/app-session', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ redirectTo: redirectTarget, runtime: requestedRuntime || undefined }),
            credentials: 'same-origin'
          });
        })
        .then(function(res) {
          if (!res) return null;
          if (res.ok) return res.json();
          if (res.status === 404) {
            if (provisionStarted) {
              showLoadingState('Preparing your Matrix computer...');
              pollProvisioningSession();
              return null;
            }
            if (checkoutJustCompleted) {
              startProvisioningFromClerkSession();
              return null;
            }
            showNoRuntimeState();
            return null;
          }
          if (res.status === 402) {
            openBillingSettingsFromClerkSession();
            return null;
          }
          showSignedInRecoveryState();
          return null;
        })
        .then(function(payload) {
          if (!payload) return;
          window.location.replace(deviceReturnTarget || payload.redirectTo || redirectTarget);
        })
        .catch(function(err) {
          console.error('[matrix] Clerk session exchange failed', err instanceof Error ? err.message : String(err));
          showSignedInRecoveryState();
        });
    }
    function initClerk() {
      window.Clerk.load({ signInUrl: '/sign-in', signUpUrl: '/sign-up' }).then(function() {
        if (window.Clerk.user) {
          continueWithClerkSession();
          return;
        }
        var el = document.getElementById('auth');
        el.innerHTML = '';
        if ('${mode}' === 'sign-up') {
          window.Clerk.mountSignUp(el, {
            signInUrl: '/sign-in',
            forceRedirectUrl: redirectTarget,
            fallbackRedirectUrl: redirectTarget,
            signUpForceRedirectUrl: redirectTarget,
            signUpFallbackRedirectUrl: redirectTarget,
            appearance: appearance
          });
        } else {
          window.Clerk.mountSignIn(el, {
            signUpUrl: '/sign-up',
            forceRedirectUrl: redirectTarget,
            fallbackRedirectUrl: redirectTarget,
            signInForceRedirectUrl: redirectTarget,
            signInFallbackRedirectUrl: redirectTarget,
            appearance: appearance
          });
        }
      });
    }
    if (window.Clerk) {
      initClerk();
    } else {
      document.getElementById('clerk-script').addEventListener('load', initClerk);
    }
  </script>
</body>
</html>`;
}

export function getNoContainerPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix OS</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 50% 46%, rgba(196, 162, 101, 0.16), transparent 32%),
        linear-gradient(180deg, #fffdf6 0%, #f4efe4 100%);
      color: #2f392c;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 28px;
    }
    main {
      width: min(620px, 100%);
      display: grid;
      justify-items: center;
      gap: 26px;
      text-align: center;
    }
    .mark {
      width: 74px;
      height: 74px;
      border-radius: 24px;
      border: 1px solid rgba(47, 57, 44, 0.18);
      position: relative;
      background: rgba(255, 255, 255, 0.42);
      box-shadow: 0 24px 70px rgba(47, 57, 44, 0.12);
    }
    .mark::before {
      content: "";
      position: absolute;
      inset: 11px;
      border-radius: 18px;
      border: 2px solid rgba(47, 57, 44, 0.16);
      border-top-color: #c4a265;
      animation: spin 1.3s linear infinite;
    }
    .mark::after {
      content: "M";
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      font-size: 30px;
      font-weight: 700;
      color: #2f392c;
    }
    h1 {
      margin: 0;
      font-size: clamp(34px, 8vw, 68px);
      font-weight: 500;
      line-height: 0.96;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    p {
      max-width: 520px;
      color: rgba(47, 57, 44, 0.68);
      font-size: 16px;
      line-height: 1.65;
      margin: 0;
    }
    .status {
      min-height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid rgba(47, 57, 44, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.48);
      padding: 7px 12px;
      color: rgba(47, 57, 44, 0.72);
      font-size: 13px;
      box-shadow: 0 12px 40px rgba(47, 57, 44, 0.08);
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .mark::before { animation-duration: 1ms; animation-iteration-count: 1; }
    }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true"></div>
    <h1>Preparing Matrix OS</h1>
    <p>Your cloud computer is not ready yet. Matrix will bring you here automatically as soon as provisioning finishes.</p>
    <p class="status">Computer status: pending</p>
  </main>
</body>
</html>`;
}

export function getVpsBootPage(input: { status: string }) {
  const title = input.status === 'recovering' ? 'Restoring Matrix OS' : 'Booting Matrix OS';
  const detail = input.status === 'recovering'
    ? 'Matrix is restoring your workspace and will bring you back automatically.'
    : 'Matrix is preparing your cloud computer. This usually takes a couple of minutes.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="8">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 50% 42%, rgba(196, 162, 101, 0.14), transparent 31%),
        linear-gradient(180deg, #fffdf6 0%, #f5efe2 100%);
      color: #2f392c;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 28px;
    }
    main {
      width: min(620px, 100%);
      display: grid;
      justify-items: center;
      gap: 28px;
      text-align: center;
    }
    .mark {
      width: 132px;
      height: 132px;
      border-radius: 50%;
      border: 1px solid rgba(47, 57, 44, 0.12);
      display: grid;
      place-items: center;
      background: rgba(255, 253, 246, 0.62);
      box-shadow: 0 24px 90px rgba(47, 57, 44, 0.12);
      position: relative;
      overflow: hidden;
    }
    .mark::before {
      content: "";
      width: 68px;
      height: 68px;
      border-radius: 50%;
      border: 2px solid rgba(196, 162, 101, 0.38);
      border-top-color: #c4a265;
      animation: spin 1.9s cubic-bezier(0.16, 1, 0.3, 1) infinite;
    }
    .mark::after {
      content: "M";
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      font-size: 30px;
      font-weight: 700;
      color: #2f392c;
    }
    .wordmark {
      margin: 0;
      font-size: clamp(34px, 8vw, 68px);
      font-weight: 500;
      line-height: 0.96;
      text-transform: uppercase;
      background: linear-gradient(90deg, #2f392c 0%, #2f392c 24%, #c4a265 50%, #2f392c 76%, #2f392c 100%);
      background-size: 300% 100%;
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
      animation: shimmer 8s ease-in-out infinite, glow 8s ease-in-out infinite;
    }
    .copy {
      display: grid;
      gap: 14px;
      max-width: 520px;
    }
    p {
      color: rgba(47, 57, 44, 0.68);
      font-size: 16px;
      line-height: 1.65;
      margin: 0;
    }
    .status {
      min-height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid rgba(47, 57, 44, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.48);
      padding: 7px 12px;
      color: rgba(47, 57, 44, 0.72);
      font-size: 13px;
      box-shadow: 0 12px 40px rgba(47, 57, 44, 0.08);
    }
    strong { color: #2f392c; font-weight: 700; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes shimmer {
      0%, 100% { background-position: 200% 0; }
      50% { background-position: -100% 0; }
    }
    @keyframes glow {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.12); }
    }
    @media (prefers-reduced-motion: reduce) {
      .mark::before, .wordmark { animation-duration: 1ms; animation-iteration-count: 1; }
    }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true"></div>
    <div class="copy">
      <h1 class="wordmark">${title}</h1>
      <p>${detail}</p>
    </div>
    <p class="status">Instance status: <strong>${escapeHtml(input.status)}</strong></p>
  </main>
</body>
</html>`;
}

const SERVER_STRENGTHS: Record<string, { vcpu: number; memoryGiB: number; diskGiB?: number }> = {
  cpx11: { vcpu: 2, memoryGiB: 2, diskGiB: 40 },
  cpx21: { vcpu: 3, memoryGiB: 4, diskGiB: 80 },
  cpx22: { vcpu: 2, memoryGiB: 4, diskGiB: 80 },
  cpx31: { vcpu: 4, memoryGiB: 8, diskGiB: 160 },
  cpx41: { vcpu: 8, memoryGiB: 16, diskGiB: 240 },
  cpx51: { vcpu: 16, memoryGiB: 32, diskGiB: 360 },
  cx22: { vcpu: 2, memoryGiB: 4, diskGiB: 40 },
  cx32: { vcpu: 4, memoryGiB: 8, diskGiB: 80 },
  cx42: { vcpu: 8, memoryGiB: 16, diskGiB: 160 },
  cx52: { vcpu: 16, memoryGiB: 32, diskGiB: 320 },
};

function machineStrength(machine: UserMachineRecord): {
  serverType: string;
  label: string;
  detail: string;
} {
  const serverType = machine.serverType;
  if (!serverType) {
    return {
      serverType: 'Unknown plan',
      label: 'Unknown',
      detail: 'CPU/RAM unavailable',
    };
  }
  const strength = SERVER_STRENGTHS[serverType.toLowerCase()];
  if (!strength) {
    return {
      serverType,
      label: serverType,
      detail: 'CPU/RAM unavailable',
    };
  }
  return {
    serverType,
    label: `${strength.vcpu} vCPU`,
    detail: `${strength.memoryGiB} GB RAM${strength.diskGiB ? ` · ${strength.diskGiB} GB disk` : ''}`,
  };
}

export type RuntimePickerMachine = UserMachineRecord & {
  displayVersion: string;
};

export function getRuntimePickerPage(input: {
  machines: RuntimePickerMachine[];
  selectedHandle: string | null;
}): string {
  const rows = input.machines.map((machine) => {
    const strength = machineStrength(machine);
    const isSelected = machine.handle === input.selectedHandle;
    const version = machine.displayVersion;
    const title = machine.runtimeSlot === 'primary' ? 'Main Computer' : `${machine.runtimeSlot} Computer`;
    const started = new Date(machine.provisionedAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const statusClass = machine.status === 'running' ? 'good' : machine.status === 'failed' ? 'bad' : 'wait';
    return `<a class="machine ${isSelected ? 'selected' : ''}" href="/vm/${encodeURIComponent(machine.handle)}">
      <div class="topline">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(machine.handle)}</span>
        </div>
        <em class="${statusClass}">${escapeHtml(machine.status)}</em>
      </div>
      <div class="details">
        <span>${escapeHtml(version)}</span>
        <span>${escapeHtml(strength.label)}</span>
        <span>${escapeHtml(strength.detail)}</span>
        <span>${escapeHtml(strength.serverType)}</span>
        <span>Created ${escapeHtml(started)}</span>
      </div>
    </a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Select Matrix OS Machine</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #2f392c;
      background:
        radial-gradient(circle at 50% 42%, rgba(196, 162, 101, 0.12), transparent 31%),
        linear-gradient(180deg, #fffdf6 0%, #f5efe2 100%);
      display: grid;
      place-items: center;
      padding: 28px;
    }
    main { width: min(940px, 100%); }
    header { margin-bottom: 22px; }
    .eyebrow { color: rgba(47, 57, 44, 0.62); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.22em; margin-bottom: 10px; }
    h1 {
      margin: 0;
      font-size: clamp(32px, 6vw, 64px);
      font-weight: 500;
      line-height: 0.98;
      text-transform: uppercase;
      background: linear-gradient(90deg, #2f392c 0%, #2f392c 24%, #c4a265 50%, #2f392c 76%, #2f392c 100%);
      background-size: 300% 100%;
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
      animation: shimmer 8s ease-in-out infinite, glow 8s ease-in-out infinite;
    }
    p { color: rgba(47, 57, 44, 0.68); font-size: 16px; line-height: 1.6; max-width: 620px; margin: 14px 0 0; }
    .list { display: grid; gap: 12px; margin-top: 24px; }
    .machine {
      display: block;
      color: inherit;
      text-decoration: none;
      background: rgba(255, 255, 255, 0.64);
      border: 1px solid rgba(47, 57, 44, 0.12);
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 18px 60px rgba(47, 57, 44, 0.10);
      backdrop-filter: blur(16px);
      transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
    }
    .machine:hover { transform: translateY(-1px); border-color: rgba(196, 162, 101, 0.55); background: rgba(255, 255, 255, 0.82); }
    .machine.selected { border-color: rgba(196, 162, 101, 0.82); }
    .topline { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
    strong { display: block; font-size: 20px; text-transform: capitalize; }
    .topline span { display: block; color: rgba(47, 57, 44, 0.62); font-size: 14px; margin-top: 4px; }
    em {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      font-style: normal;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    em.good { color: #075f3b; background: rgba(223, 246, 232, 0.9); }
    em.wait { color: #74520a; background: rgba(255, 240, 199, 0.92); }
    em.bad { color: #8a1f2b; background: rgba(255, 225, 229, 0.92); }
    .details {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .details span {
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: rgba(47, 57, 44, 0.06);
      color: rgba(47, 57, 44, 0.78);
      padding: 6px 10px;
      font-size: 13px;
      white-space: nowrap;
    }
    @media (max-width: 560px) {
      body { padding: 18px; place-items: start center; }
      .topline { align-items: flex-start; }
      .details span { width: 100%; justify-content: space-between; }
    }
    @keyframes shimmer {
      0%, 100% { background-position: 200% 0; }
      50% { background-position: -100% 0; }
    }
    @keyframes glow {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.12); }
    }
    @media (prefers-reduced-motion: reduce) {
      h1 { animation-duration: 1ms; animation-iteration-count: 1; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Switch Computer</div>
      <h1>Choose your Matrix OS computer</h1>
      <p>Use your main computer for daily work, or jump into a named test VM when validating a risky feature.</p>
    </header>
    <section class="list" aria-label="Available Matrix OS machines">
      ${rows}
    </section>
  </main>
</body>
</html>`;
}
