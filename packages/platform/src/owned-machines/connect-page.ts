import { desktopFonts, desktopPalette } from '@matrix-os/brand/tokens';

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll("'", '&#39;');
}

/**
 * Approval page for connecting an owned computer. Clerk signs the person in;
 * the page then calls the lookup and approve APIs with an explicit bearer, so
 * no cookie-authenticated mutation exists. Machine-reported details are shown
 * as reported, never trusted.
 */
export function ownedConnectPage(input: { code: string; publishableKey: string | null; nonce: string }): string {
  const code = input.code.replace(/[^BCDFGHJKLMNPQRSTVWXZ-]/gi, '').toUpperCase().slice(0, 9);
  const key = input.publishableKey ? escapeAttr(input.publishableKey) : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Connect a computer -- Matrix OS</title>
  ${key ? `<script id="clerk-script" nonce="${input.nonce}" async crossorigin="anonymous" data-clerk-publishable-key="${key}"
    src="https://clerk.matrix-os.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>` : ''}
  <style nonce="${input.nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
      background: ${desktopPalette.paper}; color: ${desktopPalette.forest}; font-family: ${desktopFonts.display}; }
    main { width: 100%; max-width: 440px; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    p { color: ${desktopPalette.textMuted}; line-height: 1.5; margin: 0 0 16px; }
    .card { border: 1px solid rgba(0,0,0,0.12); border-radius: 14px; padding: 16px; margin-bottom: 16px; background: #fff; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0; font-size: 14px; }
    dt { color: ${desktopPalette.textMuted}; }
    dd { margin: 0; overflow-wrap: anywhere; }
    label { display: block; font-size: 14px; margin-bottom: 6px; }
    input { width: 100%; font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.2); margin-bottom: 12px; }
    button { width: 100%; font: inherit; font-weight: 600; padding: 12px; border: 0; border-radius: 10px;
      background: ${desktopPalette.forest}; color: #fff; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: default; }
    .note { font-size: 13px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main>
    <h1>Connect a computer</h1>
    <p id="status">Loading...</p>
    <div id="signin"></div>
    <form id="code-form" hidden>
      <label for="code">Code shown on your computer</label>
      <input id="code" name="code" autocomplete="off" maxlength="9" value="${code}">
      <button type="submit">Continue</button>
    </form>
    <section id="confirm" hidden>
      <div class="card">
        <dl>
          <dt>Hostname</dt><dd id="hostname"></dd>
          <dt>System</dt><dd id="os"></dd>
          <dt>Version</dt><dd id="version"></dd>
        </dl>
      </div>
      <p class="note">These details were reported by the computer. Only continue if you started this
        connection yourself. Never enter a code someone else gave you.</p>
      <form id="approve-form">
        <label for="name">Name this computer</label>
        <input id="name" name="name" maxlength="64" required>
        <button id="approve" type="submit">Connect</button>
      </form>
    </section>
    <section id="done" hidden>
      <p>Connected. Your computer finishes setup on its own, usually within a minute.
        Then open <a href="/">Matrix</a> and pick it from your computers.</p>
    </section>
  </main>
  <script nonce="${input.nonce}">
    (function () {
      var currentCode = '';
      function el(id) { return document.getElementById(id); }
      function show(id, visible) { el(id).hidden = !visible; }
      function status(text) { el('status').textContent = text; }
      function request(path, body) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, 10000);
        return window.Clerk.session.getToken().then(function (token) {
          return fetch(path, { method: 'POST', credentials: 'omit', signal: controller.signal,
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
            body: JSON.stringify(body) });
        }).finally(function () { clearTimeout(timer); });
      }
      var messages = {
        not_found: 'That code is not valid or has expired. Start again on your computer.',
        machine_limit: 'You already have 3 computers connected. Remove one in Settings first.',
        daily_limit: 'Too many computers connected today. Try again tomorrow.',
        handle_unavailable: 'Matrix could not set up your account name. Contact support.',
        unavailable: 'Connecting computers is unavailable right now. Try again soon.'
      };
      function lookup(code) {
        currentCode = code;
        status('Checking the code...');
        request('/api/auth/owned-enrollments/lookup', { userCode: code }).then(function (res) {
          if (!res.ok) { status(messages.not_found); show('code-form', true); return null; }
          return res.json();
        }).then(function (data) {
          if (!data) return;
          el('hostname').textContent = data.report.hostname;
          el('os').textContent = data.report.os + ' (' + data.report.arch + ')';
          el('version').textContent = data.report.agentVersion;
          el('name').value = data.report.hostname.slice(0, 64);
          show('code-form', false);
          show('confirm', true);
          status('Connect this computer to your Matrix account?');
        }).catch(function () { status(messages.unavailable); show('code-form', true); });
      }
      function start() {
        if (!window.Clerk.user) {
          status('Sign in to your Matrix account to connect this computer.');
          window.Clerk.mountSignIn(el('signin'), { forceRedirectUrl: window.location.href, fallbackRedirectUrl: window.location.href });
          return;
        }
        if (el('code').value.length >= 8) lookup(el('code').value);
        else { status('Enter the code shown on your computer.'); show('code-form', true); }
      }
      el('code-form').addEventListener('submit', function (event) { event.preventDefault(); lookup(el('code').value); });
      el('approve-form').addEventListener('submit', function (event) {
        event.preventDefault();
        el('approve').disabled = true;
        status('Connecting...');
        request('/api/auth/owned-enrollments/approve', { userCode: currentCode, name: el('name').value }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (res.ok) { show('confirm', false); show('done', true); status('Done.'); return; }
            el('approve').disabled = false;
            status(messages[data && data.code] || messages.unavailable);
          });
        }).catch(function () { el('approve').disabled = false; status(messages.unavailable); });
      });
      function boot() {
        if (!window.Clerk) { status(messages.unavailable); return; }
        window.Clerk.load().then(start).catch(function () { status('Could not load sign-in. Refresh and try again.'); });
      }
      var script = el('clerk-script');
      if (window.Clerk) boot();
      else if (script) { script.addEventListener('load', boot); script.addEventListener('error', function () { status(messages.unavailable); }); }
      else status(messages.unavailable);
    })();
  </script>
</body>
</html>`;
}
