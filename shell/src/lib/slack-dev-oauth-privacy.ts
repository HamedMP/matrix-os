const DEV_OAUTH_PAGE = /^\/vm\/([a-z0-9][a-z0-9-]{0,58}-dev)\/slack\/oauth\/complete$/;
const BROWSER_ORIGIN = 'https://app.matrix-os.com';
const HANDOFF = 'matrix-slack-dev-oauth-handoff';

export function slackDevOAuthHandle(url: Pick<URL, 'origin' | 'pathname'>): string | null {
  return url.origin === BROWSER_ORIGIN ? DEV_OAUTH_PAGE.exec(url.pathname)?.[1] ?? null : null;
}

// Runs before the shell's billing and analytics scripts. Hold the browser-only
// data in memory until the OAuth page claims it. It never becomes a DOM value.
export const SLACK_DEV_OAUTH_SCRUB_SCRIPT = `(() => {
  const { origin, pathname, search, hash } = window.location;
  if (origin !== ${JSON.stringify(BROWSER_ORIGIN)} || !${DEV_OAUTH_PAGE}.test(pathname) || (!search && !hash)) return;
  window.history.replaceState(window.history.state, "", pathname);
  window.addEventListener(${JSON.stringify(HANDOFF)}, event => {
    if (typeof event.detail === "function") event.detail({ search, hash });
  }, { once: true });
})();`;

export function consumeSlackDevOAuthHandoff(): URL {
  const url = new URL(window.location.href);
  window.dispatchEvent(new CustomEvent(HANDOFF, { detail: (handoff: { search: string; hash: string }) => {
    url.search = handoff.search;
    url.hash = handoff.hash;
  } }));
  // A bundle without its beforeInteractive scrub must still clear the callback
  // before rendering or making the owner-authorized request.
  if (window.location.hash || window.location.search) {
    window.history.replaceState(window.history.state, '', url.pathname);
  }
  return url;
}
