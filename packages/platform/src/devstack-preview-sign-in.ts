import { fonts, lightFg, palette } from '@matrix-os/brand/tokens';
import { CLERK_SCRIPT_ORIGIN } from './auth-pages.js';
import { escapeHtmlAttr, escapeInlineScriptJson } from './html-escaping.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';

/** Only accept the canonical root emitted by the DevStack run API. */
export function isDevstackPreviewRoot(path: string): boolean {
  const match = /^\/vm\/([^/\n]+)\/$/.exec(path);
  return match?.[0] === path && HANDLE_PATTERN.test(match[1] ?? '');
}

export function renderDevstackPreviewSignIn(publishableKey: string, nonce: string, previewRoot: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Sign in to DevStack Preview</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: ${palette.deep}; color: ${lightFg}; font-family: ${fonts.sans}; }
    main { max-width: calc(100vw - 2rem); text-align: center; }
    #auth { display: grid; justify-content: center; }
    a { color: inherit; }
  </style>
</head>
<body>
  <main>
    <h1>Sign in to DevStack Preview</h1>
    <div id="auth" aria-live="polite">Loading sign-in…</div>
    <a id="continue" href="${escapeHtmlAttr(previewRoot)}" hidden>Continue to preview</a>
  </main>
  <script defer crossorigin="anonymous" nonce="${nonce}"
    data-clerk-publishable-key="${escapeHtmlAttr(publishableKey)}"
    src="${CLERK_SCRIPT_ORIGIN}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>
  <script nonce="${nonce}">
    var redirectTarget = ${escapeInlineScriptJson(previewRoot)};
    document.addEventListener('DOMContentLoaded', async function() {
      var auth = document.getElementById('auth');
      try {
        var clerk = window.Clerk;
        await clerk.load();
        auth.textContent = '';
        if (clerk.user) {
          document.getElementById('continue').hidden = false;
          return;
        }
        clerk.mountSignIn(auth, {
          routing: 'hash',
          forceRedirectUrl: redirectTarget,
          fallbackRedirectUrl: redirectTarget,
          withSignUp: false,
          transferable: false,
          appearance: { elements: { footerAction: { display: 'none' } } }
        });
      } catch (error) {
        console.error('[devstack] Clerk sign-in unavailable', error instanceof Error ? error.name : typeof error);
        auth.textContent = 'Sign-in could not load. Refresh to try again.';
      }
    });
  </script>
</body>
</html>`;
}
