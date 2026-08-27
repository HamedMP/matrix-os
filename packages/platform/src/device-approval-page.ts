import { desktopFonts, desktopPalette } from '@matrix-os/brand/tokens';

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

export function approvalPage(
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
    var selectedRuntimeSlot = '';
    var computerSelectionRequired = true;
    var clerkAppearance = {
      variables: {
        colorPrimary: '${desktopPalette.forest}',
        colorBackground: '${desktopPalette.paper}',
        colorText: '${desktopPalette.forest}',
        colorTextSecondary: '${desktopPalette.textMuted}',
        borderRadius: '14px',
        fontFamily: '${desktopFonts.sans}',
      },
      elements: {
        rootBox: { width: '100%' },
        cardBox: { width: '100%', boxShadow: 'none' },
        card: { width: '100%', padding: '0', boxShadow: 'none', background: 'transparent' },
        headerTitle: { fontFamily: '${desktopFonts.display}' },
        formButtonPrimary: { backgroundColor: '${desktopPalette.forest}' },
        footer: { background: 'transparent' },
      },
    };

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

    function updateSignedInIdentity() {
      var instance = document.getElementById('instance-line');
      var card = document.getElementById('identity-card');
      if (!window.Clerk || !window.Clerk.user) return;
      var user = window.Clerk.user;
      var handle = user.username || user.primaryEmailAddress?.emailAddress || user.id;
      var email = user.primaryEmailAddress?.emailAddress || '';
      var displayName = user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || handle;
      var avatar = document.getElementById('identity-avatar');
      var fallback = document.getElementById('identity-avatar-fallback');
      var name = document.getElementById('identity-name');
      var username = document.getElementById('identity-username');
      var emailLine = document.getElementById('identity-email');
      if (name) name.textContent = displayName;
      if (username) {
        username.textContent = user.username ? '@' + user.username : '';
        username.hidden = !user.username;
      }
      if (emailLine) {
        emailLine.textContent = email;
        emailLine.hidden = !email;
      }
      if (avatar && user.imageUrl) {
        avatar.addEventListener('error', function() {
          avatar.hidden = true;
          if (fallback) {
            fallback.textContent = displayName.slice(0, 1).toUpperCase();
            fallback.hidden = false;
          }
        }, { once: true });
        avatar.src = user.imageUrl;
        avatar.alt = displayName;
        avatar.hidden = false;
        if (fallback) fallback.hidden = true;
      } else if (fallback) {
        fallback.textContent = displayName.slice(0, 1).toUpperCase();
        fallback.hidden = false;
      }
      if (card) card.hidden = false;
      if (instance) instance.textContent = 'signed in: @' + handle + ' on app.matrix-os.com';
    }

    function updateSelectedComputer() {
      var select = document.getElementById('computer-select');
      var instance = document.getElementById('instance-line');
      selectedRuntimeSlot = select?.value || '';
      runtimeReady = Boolean(selectedRuntimeSlot);
      if (instance && select?.selectedOptions[0]) {
        instance.textContent = 'computer: ' + select.selectedOptions[0].textContent;
      }
      setBusy(false);
    }

    function renderComputers(payload) {
      var section = document.getElementById('computer-field');
      var select = document.getElementById('computer-select');
      if (!section || !select || !payload || !Array.isArray(payload.items)) return false;
      var available = payload.items.filter(function(computer) {
        return computer && computer.availability === 'available' &&
          typeof computer.runtimeSlot === 'string' && typeof computer.handle === 'string';
      });
      if (available.length === 0) return false;
      computerSelectionRequired = true;
      select.innerHTML = '';
      available.forEach(function(computer) {
        var option = document.createElement('option');
        option.value = computer.runtimeSlot;
        option.textContent = computer.label + ' - ' + computer.handle;
        select.appendChild(option);
      });
      var preferredSlot = typeof payload.selectedSlot === 'string'
        ? payload.selectedSlot
        : available.some(function(computer) { return computer.runtimeSlot === 'primary'; })
          ? 'primary'
          : available[0].runtimeSlot;
      select.value = preferredSlot;
      if (!select.value) select.selectedIndex = 0;
      select.onchange = updateSelectedComputer;
      section.hidden = false;
      updateSelectedComputer();
      return true;
    }

    async function loadComputers(token) {
      try {
        var response = await fetchWithTimeout('/api/auth/computers', {
          headers: { Authorization: \`Bearer \${token}\` },
          credentials: 'same-origin',
        });
        if (response.status === 401 || response.status === 403) return 'auth';
        if (!response.ok) return 'error';
        return renderComputers(await response.json()) ? 'ok' : 'empty';
      } catch (err) {
        console.error('[matrix] Computer inventory failed', err instanceof Error ? err.message : String(err));
        return 'error';
      }
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
        'Create or activate your Matrix computer first. Stripe Checkout confirms whether your account qualifies for the current free trial (3 days by default), its exact length, and the first charge before setup.',
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
          appearance: clerkAppearance,
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
          appearance: clerkAppearance,
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
        var computerState = await loadComputers(token);
        if (computerState === 'auth') {
          showAuth();
          return;
        }
        if (computerState === 'ok') {
          showConfirm();
          return;
        }
        if (computerState === 'error') {
          showSignedInRecoveryState();
          return;
        }
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
          computerSelectionRequired = false;
          runtimeReady = true;
          showConfirm();
          return;
        }
        if (res.status === 402 || res.status === 404) {
          // Billing-required clients enter browser billing; only native no-runtime 404s keep dedicated setup copy.
          if (nativeApp && res.status === 404) {
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
        if (computerSelectionRequired && !selectedRuntimeSlot) {
          setStatus('Choose a computer to continue.');
          return;
        }
        if (selectedRuntimeSlot) body.set('runtimeSlot', selectedRuntimeSlot);
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
        updateSignedInIdentity();
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
    [hidden] { display: none !important; }
    :root {
      color-scheme: light;
      --forest: ${desktopPalette.forest};
      --coral: ${desktopPalette.coral};
      --gold: ${desktopPalette.gold};
      --green: ${desktopPalette.green};
      --blue: ${desktopPalette.blue};
      --paper: ${desktopPalette.paper};
      --canvas: ${desktopPalette.canvas};
      --ink-muted: ${desktopPalette.textMuted};
      --stage-start: ${desktopPalette.stageStart};
      --forest-hover: ${desktopPalette.forestHover};
      --danger: ${desktopPalette.danger};
      --line: rgba(14, 52, 34, 0.14);
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 12% 10%, rgba(241, 195, 121, 0.45), transparent 30rem),
        radial-gradient(circle at 88% 90%, rgba(197, 214, 226, 0.65), transparent 34rem),
        var(--canvas);
      color: var(--forest);
      font-family: ${desktopFonts.sans};
      padding: clamp(16px, 4vw, 48px);
    }
    main {
      width: min(1180px, 100%);
      display: grid;
      grid-template-columns: minmax(0, 1.12fr) minmax(360px, 0.88fr);
      align-items: stretch;
      overflow: hidden;
      border: 1px solid rgba(14, 52, 34, 0.18);
      border-radius: 28px;
      background: var(--paper);
      box-shadow: 0 34px 100px rgba(14, 52, 34, 0.18);
    }
    .desktop-stage {
      position: relative;
      min-height: 650px;
      display: flex;
      flex-direction: column;
      background:
        radial-gradient(circle at 78% 16%, rgba(208, 110, 83, 0.7), transparent 26rem),
        linear-gradient(145deg, var(--stage-start) 0%, var(--forest) 52%, ${desktopPalette.forestDeep} 100%);
      color: var(--paper);
      overflow: hidden;
    }
    .desktop-stage::after {
      content: "";
      position: absolute;
      inset: auto -16% -34% 18%;
      aspect-ratio: 1;
      border-radius: 50%;
      background: rgba(190, 215, 123, 0.18);
      filter: blur(2px);
      pointer-events: none;
    }
    .brand-bar {
      position: relative;
      z-index: 1;
      min-height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 22px;
      border-bottom: 1px solid rgba(252, 252, 248, 0.15);
      background: rgba(252, 252, 248, 0.07);
      backdrop-filter: blur(18px);
    }
    .brand-lockup { display: flex; align-items: center; gap: 10px; font-weight: 680; }
    .brand-mark {
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      border-radius: 9px;
      background: var(--green);
      color: var(--forest);
      font-family: ${desktopFonts.display};
      font-weight: 800;
    }
    .secure-label { color: rgba(252, 252, 248, 0.7); font-size: 12px; }
    .stage-content {
      position: relative;
      z-index: 1;
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 40px;
      padding: clamp(34px, 7vw, 72px);
    }
    .eyebrow {
      margin: 0 0 14px;
      color: var(--green);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.13em;
      text-transform: uppercase;
    }
    .stage-content h1 {
      max-width: 520px;
      margin: 0;
      color: var(--paper);
      font-family: ${desktopFonts.display};
      font-size: clamp(40px, 6vw, 68px);
      font-weight: 580;
      letter-spacing: -0.045em;
      line-height: 0.98;
    }
    .stage-lede { max-width: 470px; margin-top: 20px; color: rgba(252, 252, 248, 0.72); }
    .terminal-window {
      overflow: hidden;
      border: 1px solid rgba(252, 252, 248, 0.2);
      border-radius: 18px;
      background: rgba(5, 29, 18, 0.62);
      box-shadow: 0 22px 60px rgba(3, 20, 12, 0.32);
      backdrop-filter: blur(18px);
    }
    .terminal-bar {
      min-height: 42px;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 14px;
      border-bottom: 1px solid rgba(252, 252, 248, 0.13);
      color: rgba(252, 252, 248, 0.65);
      font-size: 12px;
    }
    .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--coral); }
    .dot:nth-child(2) { background: var(--gold); }
    .dot:nth-child(3) { background: var(--green); }
    .terminal-title { margin-left: 6px; }
    .screen {
      padding: 20px;
      font-family: ${desktopFonts.mono};
      font-size: 13px;
      line-height: 1.7;
    }
    .prompt { color: var(--green); }
    .muted { color: rgba(252, 252, 248, 0.54); }
    .code {
      display: inline-block;
      margin: 10px 0 14px;
      padding: 9px 13px;
      border: 1px solid rgba(190, 215, 123, 0.52);
      border-radius: 10px;
      background: rgba(190, 215, 123, 0.12);
      color: var(--paper);
      font-size: 22px;
      letter-spacing: 0.1em;
    }
    .panel {
      min-width: 0;
      background: var(--paper);
      color: var(--forest);
      padding: clamp(28px, 5vw, 58px);
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 22px;
    }
    .panel .eyebrow { color: var(--coral); }
    .panel h2, .device-state h2 {
      margin: 0;
      font-family: ${desktopFonts.display};
      font-size: clamp(28px, 4vw, 42px);
      font-weight: 590;
      letter-spacing: -0.035em;
      line-height: 1.02;
    }
    p { margin: 0; color: var(--ink-muted); line-height: 1.55; }
    .trial-note {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 13px 14px;
      border: 1px solid rgba(190, 215, 123, 0.75);
      border-radius: 14px;
      background: rgba(190, 215, 123, 0.2);
      color: var(--forest);
      font-size: 13px;
    }
    .trial-note strong { display: block; }
    .trial-dot { width: 9px; height: 9px; flex: 0 0 auto; margin-top: 6px; border-radius: 50%; background: var(--coral); }
    button {
      width: 100%;
      min-height: 48px;
      background: var(--forest);
      color: var(--paper);
      border: 1px solid var(--forest);
      padding: 0.8rem 1rem;
      font-size: 0.95rem;
      font-weight: 650;
      border-radius: 14px;
      cursor: pointer;
      transition: transform 160ms ease, background 160ms ease;
    }
    button:hover:not(:disabled) { transform: translateY(-1px); background: var(--forest-hover); }
    button:focus-visible, select:focus-visible { outline: 3px solid var(--gold); outline-offset: 3px; }
    button:disabled { opacity: 0.65; cursor: wait; }
    .status { min-height: 1.25rem; color: var(--danger); font-size: 13px; }
    .identity {
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      margin-bottom: 14px;
      padding: 13px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: ${desktopPalette.surfaceMuted};
    }
    .identity-avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--forest);
    }
    .identity-avatar-fallback {
      display: grid;
      place-items: center;
      color: var(--paper);
      font-weight: 700;
    }
    .identity-copy { min-width: 0; }
    .identity-name { color: var(--forest); font-weight: 700; }
    .identity-meta {
      overflow: hidden;
      color: var(--ink-muted);
      font-size: 0.82rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .computer-field { display: grid; gap: 7px; margin: 14px 0; }
    .computer-field label { color: var(--forest); font-size: 0.82rem; font-weight: 700; }
    .computer-field select {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--paper);
      color: var(--forest);
      padding: 0 36px 0 12px;
      font: inherit;
    }
    #signin-area { min-width: 0; }
    .device-state {
      display: flex;
      flex-direction: column;
      gap: 12px;
      border-top: 1px solid var(--line);
      padding-top: 16px;
    }
    .device-state h2 { font-size: 28px; }
    @media (max-width: 820px) {
      main { grid-template-columns: 1fr; }
      .desktop-stage { min-height: 470px; }
      .stage-content { padding: 34px 28px; }
      .panel { padding: 38px 28px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
  <main>
    <section class="desktop-stage" aria-label="${productLabel} login preview">
      <div class="brand-bar">
        <div class="brand-lockup"><span class="brand-mark">M</span><span>Matrix OS</span></div>
        <span class="secure-label">Secure device connection</span>
      </div>
      <div class="stage-content">
        <div>
          <p class="eyebrow">Device authorization</p>
          <h1>Connect Matrix OS</h1>
          <p class="stage-lede">Confirm the code shown in the ${isNativeApp ? 'desktop app' : 'terminal'}, choose your cloud computer, and Matrix will finish the connection.</p>
        </div>
        <div class="terminal-window">
          <div class="terminal-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="terminal-title">${isNativeApp ? 'Matrix Desktop — device sign in' : 'matrix login'}</span></div>
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
        </div>
      </div>
    </section>
    <section class="panel">
      <div>
        <p class="eyebrow">One last step</p>
        <h2>Approve ${productLabel}</h2>
        <p>Authorize ${isNativeApp ? 'the desktop app' : 'this terminal'} to connect to your Matrix OS cloud computer. If you are new, create your account here first.</p>
      </div>
      <div class="trial-note"><span class="trial-dot"></span><span><strong>Free trial for eligible accounts</strong>The current offer is 3 days by default. A card is required. Stripe Checkout confirms whether your account qualifies, the exact trial length, and when billing starts.</span></div>
      <div id="signin-area" style="display:none"></div>
      <form id="confirm-area" method="POST" action="/auth/device/approve" style="display:none">
        <input type="hidden" name="userCode" value="${escapedCode}">
        <input type="hidden" name="csrf" value="${escapedCsrf}">
        <input id="native-redirect-uri" type="hidden" name="redirectUri" value="${escapedNativeRedirectUri}">
        <input id="native-redirect-sig" type="hidden" name="redirectSig" value="${escapedNativeRedirectSig}">
        <div id="identity-card" class="identity" hidden>
          <img id="identity-avatar" class="identity-avatar" alt="" referrerpolicy="no-referrer" hidden>
          <span id="identity-avatar-fallback" class="identity-avatar identity-avatar-fallback" aria-hidden="true" hidden></span>
          <div class="identity-copy">
            <div id="identity-name" class="identity-name"></div>
            <div id="identity-username" class="identity-meta"></div>
            <div id="identity-email" class="identity-meta"></div>
          </div>
        </div>
        <div id="computer-field" class="computer-field" hidden>
          <label for="computer-select">Computer</label>
          <select id="computer-select" name="runtimeSlot" aria-label="Computer"></select>
        </div>
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

export function approvalSuccessPage(nativeRedirectUri: string | null = null): string {
  const redirectMeta = nativeRedirectUri
    ? `<meta http-equiv="refresh" content="0; url=${escapeHtmlAttr(nativeRedirectUri)}">`
    : '';
  const redirectLink = nativeRedirectUri
    ? `<p><a href="${escapeHtmlAttr(nativeRedirectUri)}">Return to Matrix OS</a></p>`
    : '';
  const detail = nativeRedirectUri
    ? 'Opening Matrix OS now. Keep this tab open until the desktop app is in focus.'
    : 'You can close this tab and return to Matrix OS.';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${redirectMeta}<title>Connected — Matrix OS</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 10%,rgba(241,195,121,.58),transparent 28rem),radial-gradient(circle at 85% 90%,rgba(197,214,226,.8),transparent 34rem),${desktopPalette.canvas};color:${desktopPalette.forest};font-family:${desktopFonts.sans}}.card{width:min(520px,100%);padding:clamp(32px,7vw,64px);border:1px solid rgba(14,52,34,.16);border-radius:28px;background:${desktopPalette.paper};box-shadow:0 30px 90px rgba(14,52,34,.16);text-align:center}.mark{width:72px;height:72px;display:grid;place-items:center;margin:0 auto 26px;border-radius:22px;background:${desktopPalette.green};color:${desktopPalette.forest};font-family:${desktopFonts.display};font-size:30px;font-weight:800;animation:arrive .5s cubic-bezier(.2,.8,.2,1) both}.eyebrow{margin:0 0 12px;color:${desktopPalette.coral};font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase}h1{margin:0;font-family:${desktopFonts.display};font-size:clamp(38px,8vw,58px);font-weight:590;letter-spacing:-.045em;line-height:1}p{margin:18px auto 0;max-width:390px;color:${desktopPalette.textMuted};line-height:1.6}a{display:inline-flex;min-height:48px;align-items:center;justify-content:center;margin-top:8px;padding:0 22px;border-radius:14px;background:${desktopPalette.forest};color:${desktopPalette.paper};font-weight:680;text-decoration:none}a:focus-visible{outline:3px solid ${desktopPalette.gold};outline-offset:3px}@keyframes arrive{from{opacity:0;transform:translateY(8px) scale(.94)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head>
<body><main class="card"><div class="mark" aria-hidden="true">M</div><p class="eyebrow">Device approved</p><h1>You&#39;re connected</h1><p>${detail}</p>${redirectLink}</main></body></html>`;
}
