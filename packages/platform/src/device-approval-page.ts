import { desktopFonts, desktopPalette } from '@matrix-os/brand/tokens';
import { rabbitMarkSvg } from '@matrix-os/brand/marks';

const BRICOLAGE_FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&amp;display=swap" rel="stylesheet">`;

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
        fontFamily: '${desktopFonts.display}',
      },
      elements: {
        rootBox: { width: '100%' },
        cardBox: { width: '100%', boxShadow: 'none' },
        card: { width: '100%', padding: '0', boxShadow: 'none', background: 'transparent' },
        headerTitle: { fontFamily: '${desktopFonts.display}', fontWeight: '700' },
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
        button.textContent = isBusy ? 'Connecting...' : 'Approve and connect';
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
    }

    function updateSelectedComputer() {
      var select = document.getElementById('computer-select');
      selectedRuntimeSlot = select?.value || '';
      runtimeReady = Boolean(selectedRuntimeSlot);
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
        'Create or activate your Matrix computer first, then return here to connect this device.',
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
  ${BRICOLAGE_FONT_LINKS}
  <style nonce="${scriptNonce}">
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
      font-family: ${desktopFonts.display};
      font-optical-sizing: auto;
      font-style: normal;
      font-variation-settings: "wdth" 100;
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
    .brand-lockup { display: flex; align-items: center; gap: 10px; }
    .brand-name {
      font-family: "Bricolage Grotesque", sans-serif;
      font-optical-sizing: auto;
      font-size: 17px;
      font-style: normal;
      font-variation-settings: "wdth" 100;
      font-weight: 800;
      letter-spacing: -0.015em;
    }
    .rabbit-mark { display: block; width: auto; flex: 0 0 auto; fill: currentColor; }
    .rabbit-mark-phosphor { color: var(--green); height: 34px; }
    .secure-label { color: rgba(252, 252, 248, 0.7); font-size: 12px; }
    .stage-content {
      position: relative;
      z-index: 1;
      flex: 1;
      display: grid;
      grid-template-rows: 1fr auto;
      align-items: center;
      padding: clamp(34px, 7vw, 72px);
    }
    .stage-copy { align-self: center; max-width: 520px; }
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
      font-weight: 700;
      letter-spacing: -0.045em;
      line-height: 0.98;
    }
    .stage-title-line { display: block; }
    .stage-title-product { white-space: nowrap; }
    .stage-lede { max-width: 430px; margin-top: 20px; color: rgba(252, 252, 248, 0.72); }
    .stage-promise {
      align-self: end;
      max-width: 420px;
      padding-top: 20px;
      border-top: 1px solid rgba(252, 252, 248, 0.2);
      color: rgba(252, 252, 248, 0.9);
      font-family: ${desktopFonts.display};
      font-size: clamp(18px, 2vw, 24px);
      font-weight: 560;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .stage-watermark {
      position: absolute;
      right: -72px;
      bottom: -150px;
      z-index: 0;
      color: rgba(190, 215, 123, 0.08);
      pointer-events: none;
      transform: rotate(-7deg);
    }
    .stage-watermark .rabbit-mark { height: 520px; }
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
    .panel-intro { display: grid; gap: 16px; }
    .panel-intro .eyebrow { margin: 0; }
    .panel .eyebrow { color: var(--coral); }
    .panel h2, .device-state h2 {
      margin: 0;
      font-family: ${desktopFonts.display};
      font-size: clamp(28px, 4vw, 42px);
      font-weight: 700;
      letter-spacing: -0.035em;
      line-height: 1.02;
    }
    p { margin: 0; color: var(--ink-muted); line-height: 1.55; }
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
    <section class="desktop-stage" aria-label="${productLabel} secure connection">
      <div class="brand-bar">
        <div class="brand-lockup">${rabbitMarkSvg('rabbit-mark rabbit-mark-phosphor')}<span class="brand-name">Matrix OS</span></div>
        <span class="secure-label">Secure device connection</span>
      </div>
      <div class="stage-watermark">${rabbitMarkSvg('rabbit-mark stage-rabbit-mark')}</div>
      <div class="stage-content">
        <div class="stage-copy">
          <p class="eyebrow">Your private computer</p>
          <h1><span class="stage-title-line">Connect</span><span class="stage-title-line stage-title-product">Matrix OS</span></h1>
          <p class="stage-lede">Approve once to securely open your private computer from this device.</p>
        </div>
        <p class="stage-promise">One account. One private computer. Every surface.</p>
      </div>
    </section>
    <section class="panel">
      <div class="panel-intro">
        <p class="eyebrow">One last step</p>
        <h2>Approve ${productLabel}</h2>
        <p>Allow this device to open your Matrix OS cloud computer.</p>
      </div>
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
        <button id="confirm-button" type="submit" disabled>Approve and connect</button>
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${redirectMeta}<title>Connected — Matrix OS</title>${BRICOLAGE_FONT_LINKS}
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 10%,rgba(241,195,121,.58),transparent 28rem),radial-gradient(circle at 85% 90%,rgba(197,214,226,.8),transparent 34rem),${desktopPalette.canvas};color:${desktopPalette.forest};font-family:${desktopFonts.display};font-optical-sizing:auto;font-style:normal;font-variation-settings:"wdth" 100}.card{width:min(520px,100%);padding:clamp(32px,7vw,64px);border:1px solid rgba(14,52,34,.16);border-radius:28px;background:${desktopPalette.paper};box-shadow:0 30px 90px rgba(14,52,34,.16);text-align:center}.rabbit-mark{display:block;width:auto;fill:currentColor}.success-rabbit{color:${desktopPalette.forest};height:78px;margin:0 auto 26px;animation:arrive .5s cubic-bezier(.2,.8,.2,1) both}.eyebrow{margin:0 0 12px;color:${desktopPalette.coral};font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}h1{margin:0;font-family:${desktopFonts.display};font-size:clamp(38px,8vw,58px);font-weight:700;letter-spacing:-.045em;line-height:1}p{margin:18px auto 0;max-width:390px;color:${desktopPalette.textMuted};line-height:1.6}a{display:inline-flex;min-height:48px;align-items:center;justify-content:center;margin-top:8px;padding:0 22px;border-radius:14px;background:${desktopPalette.forest};color:${desktopPalette.paper};font-weight:700;text-decoration:none}a:focus-visible{outline:3px solid ${desktopPalette.gold};outline-offset:3px}@keyframes arrive{from{opacity:0;transform:translateY(8px) scale(.94)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head>
<body><main class="card">${rabbitMarkSvg('rabbit-mark success-rabbit')}<p class="eyebrow">Device approved</p><h1>You&#39;re connected</h1><p>${detail}</p>${redirectLink}</main></body></html>`;
}
