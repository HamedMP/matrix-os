import { cardShadow, fonts, palette as c, radii } from '@matrix-os/brand/tokens';
import {
  CLERK_SCRIPT_ORIGIN,
  escapeHtmlAttr,
  escapeInlineScriptJson,
} from './auth-pages.js';

const MARKETING_SIGN_IN_URL = 'https://matrix-os.com/login';
const APP_SESSION_EXCHANGE_TIMEOUT_MS = 10_000;
const HANDOFF_UNRESOLVED_TIMEOUT_MS = 12_000;

export function getSignupBillingHandoffPage(input: {
  publishableKey: string;
  scriptNonce: string;
  redirectTarget: string;
}): string {
  const escapedPublishableKey = escapeHtmlAttr(input.publishableKey);
  const redirectTargetJson = escapeInlineScriptJson(input.redirectTarget);
  const marketingSignInUrlJson = escapeInlineScriptJson(MARKETING_SIGN_IN_URL);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Opening Billing | Matrix OS</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: ${c.pageBg}; color: ${c.deep}; font-family: ${fonts.sans}; }
    .layout { width: min(72rem, 100%); min-height: 100vh; margin: 0 auto; padding: 2.5rem 1.25rem; display: grid; align-items: center; gap: 2rem; grid-template-columns: minmax(0, 1fr) minmax(380px, 430px); }
    .showcase { min-width: 0; }
    .wordmark { display: flex; align-items: center; gap: 0.625rem; margin-bottom: 1.25rem; color: ${c.forest}; font-size: 0.75rem; font-weight: 500; }
    .rabbit-tile { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid ${c.border}; border-radius: 8px; background: ${c.card}; }
    .rabbit-tile svg { width: 19px; height: 21px; fill: ${c.forest}; }
    h1 { max-width: 13ch; margin: 0; color: ${c.deep}; font-family: ${fonts.display}; font-size: clamp(2.1rem, 4vw, 2.7rem); font-weight: 400; line-height: 1.02; text-wrap: balance; }
    .lede { max-width: 40ch; margin: 0.75rem 0 0; color: ${c.mutedFg}; font-size: 0.875rem; line-height: 1.55; }
    .workspace { margin-top: 1.125rem; overflow: hidden; border: 1px solid ${c.border}; border-radius: ${radii.card}; background: ${c.card}; box-shadow: 0 20px 50px rgba(50,53,46,0.10); }
    .workspace-bar { display: flex; align-items: center; gap: 5px; padding: 7px 10px; border-bottom: 1px solid ${c.border}; background: #F1EFE7; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: ${c.border}; }
    .workspace-label { margin-left: 8px; color: ${c.subtle}; font-family: ui-monospace, monospace; font-size: 10px; }
    .workspace-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: ${c.border}; }
    .terminal { min-height: 96px; padding: 12px; background: ${c.forestDeep}; color: ${c.cream}; font-family: ui-monospace, monospace; font-size: 10px; line-height: 1.7; }
    .terminal p, .agents p { margin: 0; }
    .terminal .prompt { color: #9FB39A; }
    .terminal .done { color: #C0DD97; }
    .agents { padding: 12px; background: ${c.card}; color: ${c.deep}; font-size: 11px; }
    .agents-label { color: ${c.subtle}; font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; }
    .agent-list { display: grid; gap: 6px; margin-top: 7px; }
    .agent-idle { color: ${c.subtle}; }
    .panel-header { display: flex; justify-content: space-between; margin-bottom: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid ${c.border}; color: ${c.subtle}; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; }
    .card { min-height: 560px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; border: 1px solid ${c.border}; border-radius: 1rem; background: ${c.card}; box-shadow: ${cardShadow}; text-align: center; }
    .rabbit-mark { width: 64px; height: 72px; margin-bottom: 1.5rem; fill: ${c.forest}; }
    .spinner { width: 20px; height: 20px; margin-bottom: 1rem; border: 2px solid rgba(208,111,37,0.22); border-top-color: ${c.ember}; border-radius: 50%; animation: spin 0.8s linear infinite; }
    .alert { display: none; width: 20px; height: 20px; margin-bottom: 0.75rem; color: ${c.ember}; }
    h2 { margin: 0; color: ${c.deep}; font-size: 1.25rem; letter-spacing: -0.015em; }
    .detail { max-width: 20rem; margin: 0.75rem 0 0; color: ${c.mutedFg}; font-size: 0.875rem; line-height: 1.5rem; }
    .retry { display: none; height: 44px; align-items: center; justify-content: center; margin-top: 1.5rem; padding: 0 1.25rem; border: 0; border-radius: ${radii.control}; background: ${c.deep}; color: white; font: inherit; font-size: 0.875rem; font-weight: 500; cursor: pointer; }
    .retry:focus-visible { outline: 3px solid ${c.ember}; outline-offset: 3px; }
    .card.failed .spinner { display: none; }
    .card.failed .alert, .card.failed .retry { display: inline-flex; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; gap: 2rem; }
      .showcase { padding-bottom: 2rem; border-bottom: 1px solid ${c.border}; }
      .panel { width: min(430px, 100%); margin: 0 auto; }
    }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 1.6s; } }
  </style>
</head>
<body>
  <main class="layout" data-matrix-signup-billing-handoff="true">
    <section class="showcase">
      <div class="wordmark">
        <span class="rabbit-tile" aria-hidden="true"><svg viewBox="0 0 32 36"><path d="M9.2 15.2C5.7 10.1 4.4 3.8 6.7 1.2c2.6-2.8 6.7 5.4 7.4 10.2.6-.1 1.2-.1 1.9-.1s1.3 0 1.9.1c.7-4.8 4.8-13 7.4-10.2 2.3 2.6 1 8.9-2.5 14 3.4 2.3 5.5 6 5.5 10.2 0 7-5.5 10.6-12.3 10.6S3.7 32.4 3.7 25.4c0-4.2 2.1-7.9 5.5-10.2Zm1.6 9.1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10.4 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM12 29c1.2 1.5 2.5 2.2 4 2.2s2.8-.7 4-2.2h-8Z"/></svg></span>
        <span>matrix-os</span>
      </div>
      <h1>A computer in the cloud for your AI agents</h1>
      <p class="lede">Run Claude, Codex, and Hermes as background agents that keep going after your laptop closes.</p>
      <div class="workspace" aria-label="Matrix agent workspace preview">
        <div class="workspace-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="workspace-label">workspace</span></div>
        <div class="workspace-grid">
          <div class="terminal"><p class="prompt">$ claude build tracker</p><p>› writing ~/apps/app.tsx</p><p class="done">✓ done in 4.2s</p></div>
          <div class="agents"><p class="agents-label">Agents</p><div class="agent-list"><span>● Claude · running</span><span>● Codex · PR opened</span><span class="agent-idle">○ Hermes · idle</span></div></div>
        </div>
      </div>
    </section>
    <aside class="panel">
      <div class="panel-header"><span>Matrix account</span><span>Secure session</span></div>
      <section class="card" id="handoff-card" aria-live="polite">
        <svg class="rabbit-mark" viewBox="0 0 32 36" aria-hidden="true"><path d="M9.2 15.2C5.7 10.1 4.4 3.8 6.7 1.2c2.6-2.8 6.7 5.4 7.4 10.2.6-.1 1.2-.1 1.9-.1s1.3 0 1.9.1c.7-4.8 4.8-13 7.4-10.2 2.3 2.6 1 8.9-2.5 14 3.4 2.3 5.5 6 5.5 10.2 0 7-5.5 10.6-12.3 10.6S3.7 32.4 3.7 25.4c0-4.2 2.1-7.9 5.5-10.2Zm1.6 9.1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10.4 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM12 29c1.2 1.5 2.5 2.2 4 2.2s2.8-.7 4-2.2h-8Z"/></svg>
        <span class="spinner" aria-hidden="true"></span>
        <svg class="alert" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v6m0 4h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <h2 id="handoff-title">Loading billing status</h2>
        <p class="detail" id="handoff-detail">Matrix is checking your subscription before opening billing setup.</p>
        <button class="retry" id="retry" type="button">Try again</button>
      </section>
    </aside>
  </main>
  <script id="clerk-script" nonce="${input.scriptNonce}" async crossorigin="anonymous" data-clerk-publishable-key="${escapedPublishableKey}" src="${CLERK_SCRIPT_ORIGIN}/npm/@clerk/clerk-js@5/dist/clerk.browser.js" type="text/javascript"></script>
  <script nonce="${input.scriptNonce}">
    var redirectTarget = ${redirectTargetJson};
    var marketingSignInUrl = ${marketingSignInUrlJson};
    var retryStorageKey = 'matrix.signupBillingHandoffRetryCount';
    var retryDelays = [2000, 3000, 4000];
    var unresolvedTimer;

    function describeClientError(err) {
      return err instanceof Error ? err.name : typeof err;
    }
    function readRetryCount() {
      try {
        var raw = window.sessionStorage.getItem(retryStorageKey);
        var count = raw === null ? 0 : Number(raw);
        return Number.isInteger(count) && count >= 0 && count <= retryDelays.length ? count : retryDelays.length;
      } catch (err) {
        console.warn('[matrix] Unable to read signup handoff retry state', describeClientError(err));
        return retryDelays.length;
      }
    }
    function writeRetryCount(count) {
      try {
        window.sessionStorage.setItem(retryStorageKey, String(count));
        return true;
      } catch (err) {
        console.warn('[matrix] Unable to write signup handoff retry state', describeClientError(err));
        return false;
      }
    }
    function clearRetryCount() {
      try {
        window.sessionStorage.removeItem(retryStorageKey);
      } catch (err) {
        console.warn('[matrix] Unable to clear signup handoff retry state', describeClientError(err));
      }
    }
    function showRetryState() {
      if (unresolvedTimer !== undefined) window.clearTimeout(unresolvedTimer);
      var card = document.getElementById('handoff-card');
      card.classList.add('failed');
      document.getElementById('handoff-title').textContent = 'Billing settings are still loading';
      document.getElementById('handoff-detail').textContent = 'Matrix could not finish opening billing. Try again after a moment.';
    }
    function scheduleAuthShellRetry() {
      if (unresolvedTimer !== undefined) window.clearTimeout(unresolvedTimer);
      var retryCount = readRetryCount();
      if (retryCount >= retryDelays.length || !writeRetryCount(retryCount + 1)) {
        showRetryState();
        return;
      }
      window.setTimeout(function() { window.location.reload(); }, retryDelays[retryCount]);
    }
    function exchangeAppSession() {
      return window.Clerk.session.getToken().then(function(token) {
        if (!token) throw new Error('Missing session token');
        var controller = new AbortController();
        var timeoutId = window.setTimeout(function() { controller.abort(); }, ${APP_SESSION_EXCHANGE_TIMEOUT_MS});
        return fetch('/api/auth/app-session', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirectTo: redirectTarget }),
          credentials: 'same-origin',
          signal: controller.signal
        }).then(function(response) {
          if (!response.ok) {
            var exchangeError = new Error('App session request rejected');
            exchangeError.name = 'AppSessionExchangeError';
            throw exchangeError;
          }
          return response;
        }).finally(function() { window.clearTimeout(timeoutId); });
      });
    }
    function initClerk() {
      window.Clerk.load({ signInUrl: '/sign-in', signUpUrl: '/sign-up' }).then(function() {
        if (!window.Clerk.user || !window.Clerk.session) {
          clearRetryCount();
          window.location.replace(marketingSignInUrl);
          return;
        }
        return exchangeAppSession()
          .catch(function(err) {
            console.warn('[matrix] Signup handoff session exchange failed', describeClientError(err));
          })
          .then(scheduleAuthShellRetry);
      }).catch(function(err) {
        console.warn('[matrix] Signup handoff Clerk load failed', describeClientError(err));
        scheduleAuthShellRetry();
      });
    }
    document.getElementById('retry').addEventListener('click', function() {
      clearRetryCount();
      window.location.reload();
    });
    unresolvedTimer = window.setTimeout(showRetryState, ${HANDOFF_UNRESOLVED_TIMEOUT_MS});
    if (window.Clerk) {
      initClerk();
    } else {
      document.getElementById('clerk-script').addEventListener('load', initClerk);
      document.getElementById('clerk-script').addEventListener('error', scheduleAuthShellRetry);
    }
  </script>
</body>
</html>`;
}
