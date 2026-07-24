import { cardShadow, fonts, palette as c, radii } from '@matrix-os/brand/tokens';
import {
  CLERK_SCRIPT_ORIGIN,
  escapeHtmlAttr,
  escapeInlineScriptJson,
} from './auth-pages.js';
import {
  renderOfficialAgentRows,
  renderOfficialRabbitSvg,
} from './signup-billing-handoff-artwork.js';

const MARKETING_SIGN_IN_URL = 'https://matrix-os.com/login';

function renderFeatureShowcase(): string {
  return `<section class="showcase" data-matrix-feature-showcase="product">
      <div class="wordmark">
        <span class="wordmark-icon">${renderOfficialRabbitSvg('rabbit wordmark-rabbit')}</span>
        <span>matrix-os</span>
      </div>
      <h1>A computer in the cloud for your AI agents</h1>
      <p class="lede">Create your free account. Your private machine spins up only when you provision it.</p>
      <div class="workspace">
        <div class="workspace-bar">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span class="workspace-label">workspace</span>
        </div>
        <div class="workspace-grid">
          <div class="terminal">
            <p class="prompt">$ claude build tracker</p>
            <p>› writing ~/apps/app.tsx</p>
            <p class="done">✓ done in 4.2s</p>
          </div>
          <div class="agents">
            <p class="agents-label">Agents</p>
            <div class="agent-list">
              <span><i></i>Claude · running</span>
              <span><i></i>Codex · PR opened</span>
              <span class="agent-idle"><i></i>Hermes · idle</span>
            </div>
          </div>
        </div>
      </div>
      <div class="mobile-agents">${renderOfficialAgentRows()}</div>
    </section>`;
}

function renderHandoffCard(): string {
  return `<aside class="panel">
      <div class="panel-header"><span>Matrix account</span><span>Secure session</span></div>
      <div class="card-shell">
        <section class="card" id="handoff-card" aria-live="polite">
          ${renderOfficialRabbitSvg('rabbit status-rabbit')}
          <span class="spinner" aria-hidden="true"></span>
          <svg class="alert" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
            <path d="M12 7v6m0 4h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <h2 id="handoff-title">Loading billing status</h2>
          <p class="detail" id="handoff-detail">Matrix is checking your subscription before opening billing setup.</p>
          <button class="retry" id="retry" type="button">Try again</button>
        </section>
      </div>
    </aside>`;
}

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
    .wordmark { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 2rem; color: ${c.forest}; font-size: 0.875rem; font-weight: 500; letter-spacing: -0.01em; }
    .wordmark-icon { width: 34px; height: 34px; display: grid; place-items: center; overflow: hidden; border: 1px solid ${c.border}; border-radius: 0.5rem; background: ${c.card}; padding: 0.375rem; }
    .rabbit { display: block; max-width: 100%; max-height: 100%; }
    .wordmark-rabbit { width: 100%; height: 100%; }
    h1 { max-width: 13ch; margin: 0; color: ${c.deep}; font-family: ${fonts.display}; font-size: clamp(2.4rem, 4.2vw, 3.2rem); font-weight: 400; line-height: 1.02; letter-spacing: -0.01em; text-wrap: balance; }
    .lede { max-width: 42ch; margin: 1.25rem 0 0; color: ${c.mutedFg}; font-size: 0.9375rem; line-height: 1.6; }
    .workspace { max-width: 440px; margin-top: 2.5rem; overflow: hidden; border: 1px solid ${c.border}; border-radius: 1rem; background: ${c.card}; box-shadow: 0 24px 60px rgba(50,53,46,0.10); }
    .workspace-bar { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid ${c.border}; background: #F1EFE7; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: ${c.border}; }
    .workspace-label { margin-left: 8px; color: ${c.subtle}; font-family: ui-monospace, monospace; font-size: 10px; }
    .workspace-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: ${c.border}; }
    .terminal { min-height: 116px; padding: 14px; background: ${c.forestDeep}; color: ${c.cream}; font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.7; }
    .terminal p, .agents p { margin: 0; }
    .terminal .prompt { color: #9FB39A; }
    .terminal .done { color: #C0DD97; }
    .agents { padding: 14px; background: ${c.card}; color: ${c.deep}; font-size: 12px; }
    .agents-label { color: ${c.subtle}; font-size: 10px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
    .agent-list { display: grid; gap: 8px; margin-top: 10px; }
    .agent-list span { display: flex; align-items: center; gap: 8px; }
    .agent-list i { width: 6px; height: 6px; border-radius: 50%; background: #639922; }
    .agent-list .agent-idle { color: ${c.subtle}; }
    .agent-list .agent-idle i { background: ${c.border}; }
    .mobile-agents { display: none; }
    .mobile-agent { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 0; color: ${c.forest}; font-size: 0.875rem; font-weight: 500; }
    .mobile-agent + .mobile-agent { border-top: 1px solid ${c.border}; }
    .agent-icon { width: 2rem; height: 2rem; display: grid; flex: none; place-items: center; overflow: hidden; border: 1px solid ${c.border}; border-radius: 0.5rem; background: ${c.card}; padding: 0.375rem; }
    .agent-logo { display: block; width: 20px; height: 20px; max-width: 100%; max-height: 100%; }
    .rabbit-agent-logo { object-fit: contain; }
    .panel { width: 100%; max-width: 430px; justify-self: end; }
    .panel-header { display: flex; justify-content: space-between; margin-bottom: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid ${c.border}; color: ${c.subtle}; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; }
    .card-shell { position: relative; overflow: hidden; padding: 1rem; border: 1px solid ${c.border}; border-radius: 1rem; background: ${c.card}; box-shadow: ${cardShadow}; }
    .card { min-height: 560px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 3rem 1rem; text-align: center; }
    .status-rabbit { width: 56px; height: 74px; margin-bottom: 1.75rem; object-fit: contain; }
    .spinner { width: 20px; height: 20px; margin-bottom: 1rem; border: 2px solid rgba(208,111,37,0.22); border-top-color: ${c.ember}; border-radius: 50%; animation: spin 0.8s linear infinite; }
    .alert { display: none; width: 20px; height: 20px; margin-bottom: 0.75rem; color: ${c.ember}; }
    h2 { margin: 0; color: ${c.deep}; font-size: 1.25rem; letter-spacing: -0.015em; }
    .detail { max-width: 20rem; margin: 0.75rem 0 0; color: ${c.mutedFg}; font-size: 0.875rem; line-height: 1.5rem; }
    .retry { display: none; height: 44px; align-items: center; justify-content: center; margin-top: 1.5rem; padding: 0 1.25rem; border: 0; border-radius: ${radii.control}; background: ${c.deep}; color: white; font: inherit; font-size: 0.875rem; font-weight: 500; cursor: pointer; }
    .retry:focus-visible { outline: 3px solid ${c.ember}; outline-offset: 3px; }
    .card.failed .spinner { display: none; }
    .card.failed .alert, .card.failed .retry { display: inline-flex; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 1023px) {
      .layout { grid-template-columns: 1fr; }
      .showcase { padding-bottom: 2rem; border-bottom: 1px solid ${c.border}; }
      .workspace { display: none; }
      .mobile-agents { display: grid; width: 100%; max-width: 28rem; margin: 1.75rem auto 0; border-top: 1px solid ${c.border}; border-bottom: 1px solid ${c.border}; }
      .panel { margin: 0 auto; justify-self: center; }
    }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 1.6s; } }
  </style>
</head>
<body>
  <main class="layout" data-matrix-auth-layout="platform-fallback" data-matrix-signup-billing-handoff="true">
    ${renderFeatureShowcase()}
    ${renderHandoffCard()}
  </main>
  <script id="clerk-script" nonce="${input.scriptNonce}" async crossorigin="anonymous" data-clerk-publishable-key="${escapedPublishableKey}" src="${CLERK_SCRIPT_ORIGIN}/npm/@clerk/clerk-js@5/dist/clerk.browser.js" type="text/javascript"></script>
  <script nonce="${input.scriptNonce}">
    var redirectTarget = ${redirectTargetJson};
    var marketingSignInUrl = ${marketingSignInUrlJson};
    var retryStorageKey = 'matrix.signupBillingHandoffRetryCount';
    var retryDelays = [2000, 3000, 4000];
    var unresolvedTimer;

    function clientErrorKind(err) {
      return err instanceof Error ? err.name : typeof err;
    }
    function readRetryCount() {
      try {
        var value = Number(window.sessionStorage.getItem(retryStorageKey) || '0');
        return Number.isInteger(value) && value >= 0 && value <= retryDelays.length
          ? value
          : retryDelays.length;
      } catch (err) {
        console.warn('[matrix] Unable to read signup handoff retry state', clientErrorKind(err));
        return retryDelays.length;
      }
    }
    function writeRetryCount(value) {
      try {
        window.sessionStorage.setItem(retryStorageKey, String(value));
        return true;
      } catch (err) {
        console.warn('[matrix] Unable to write signup handoff retry state', clientErrorKind(err));
        return false;
      }
    }
    function clearRetryCount() {
      try {
        window.sessionStorage.removeItem(retryStorageKey);
      } catch (err) {
        console.warn('[matrix] Unable to clear signup handoff retry state', clientErrorKind(err));
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
      var retryCount = readRetryCount();
      if (retryCount >= retryDelays.length || !writeRetryCount(retryCount + 1)) {
        showRetryState();
        return;
      }
      window.setTimeout(function() {
        window.location.assign(window.location.href);
      }, retryDelays[retryCount]);
    }
    function exchangeAppSession() {
      return window.Clerk.session.getToken().then(function(token) {
        if (!token) throw new Error();
        return fetch('/api/auth/app-session', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirectTo: redirectTarget }),
          credentials: 'same-origin',
          signal: AbortSignal.timeout(10000)
        }).then(function(response) {
          if (!response.ok) throw new Error();
          return response;
        });
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
            console.warn('[matrix] Signup handoff session exchange failed', clientErrorKind(err));
          })
          .then(scheduleAuthShellRetry);
      }).catch(function(err) {
        console.warn('[matrix] Signup handoff Clerk load failed', clientErrorKind(err));
        scheduleAuthShellRetry();
      });
    }
    document.getElementById('retry').addEventListener('click', function() {
      clearRetryCount();
      window.location.assign(window.location.href);
    });
    unresolvedTimer = window.setTimeout(showRetryState, 12000);
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
