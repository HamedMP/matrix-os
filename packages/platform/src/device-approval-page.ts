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
          var computerState = await loadComputers(token);
          if (computerState === 'auth') {
            showAuth();
            return;
          }
          if (computerState === 'empty') {
            showRuntimeSetupState();
            return;
          }
          if (computerState === 'error') {
            showSignedInRecoveryState();
            return;
          }
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
        if (!selectedRuntimeSlot) {
          setStatus('Choose a computer to continue.');
          return;
        }
        body.set('runtimeSlot', selectedRuntimeSlot);
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
    .identity {
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      padding: 12px;
      border: 1px solid #d7d0c2;
      border-radius: 6px;
      background: #fffdf8;
    }
    .identity-avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      object-fit: cover;
      background: #25332d;
    }
    .identity-avatar-fallback {
      display: grid;
      place-items: center;
      color: #fffdf8;
      font-weight: 700;
    }
    .identity-copy { min-width: 0; }
    .identity-name { color: #25332d; font-weight: 700; }
    .identity-meta {
      overflow: hidden;
      color: #66736c;
      font-size: 0.82rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .computer-field { display: grid; gap: 7px; margin: 14px 0; }
    .computer-field label { color: #35453e; font-size: 0.82rem; font-weight: 700; }
    .computer-field select {
      width: 100%;
      min-height: 42px;
      border: 1px solid #b9c2bc;
      border-radius: 6px;
      background: #fff;
      color: #25332d;
      padding: 0 36px 0 12px;
      font: inherit;
    }
    .computer-field select:focus-visible { outline: 2px solid #2c7254; outline-offset: 2px; }
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
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">${redirectMeta}<title>Authorized</title>
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#eee;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{max-width:380px;padding:2rem;background:#141414;border:1px solid #222;border-radius:8px;text-align:center}</style></head>
<body><div class="card"><h1>Login successful</h1><p>You can close this tab and return to Matrix OS.</p>${redirectLink}</div></body></html>`;
}
