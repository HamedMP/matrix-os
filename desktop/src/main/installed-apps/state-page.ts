// The static page an installed-app window shows instead of the app: while it
// opens, when signed out, or when the app can't open. No script runs here;
// its buttons are links to reserved `.invalid` URLs that the main process
// intercepts in `will-navigate`, so the page needs no preload or IPC.

export type InstalledAppStateKind = "loading" | "signed-out" | "missing" | "unavailable";

const ACTION_ORIGIN = "https://installed-app.matrix-os.invalid";
export const INSTALLED_APP_ACTION_URLS = {
  retry: `${ACTION_ORIGIN}/retry`,
  openMatrix: `${ACTION_ORIGIN}/open-matrix`,
} as const;

export type InstalledAppAction = "retry" | "open-matrix";

export function installedAppAction(url: string): InstalledAppAction | null {
  if (url === INSTALLED_APP_ACTION_URLS.retry) return "retry";
  if (url === INSTALLED_APP_ACTION_URLS.openMatrix) return "open-matrix";
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

interface PageCopy { title: string; body: string | null; action: { label: string; href: string } | null }

function copyFor(kind: InstalledAppStateKind, appName: string): PageCopy {
  switch (kind) {
    case "loading":
      return { title: `Opening ${appName}…`, body: null, action: null };
    case "signed-out":
      return {
        title: `Sign in to Matrix to open ${appName}`,
        body: "Installed apps use the Matrix session of this computer.",
        action: { label: "Open Matrix", href: INSTALLED_APP_ACTION_URLS.openMatrix },
      };
    case "missing":
      return {
        title: `${appName} isn't available`,
        body: "It may have been deleted, or it belongs to another Matrix computer.",
        action: { label: "Retry", href: INSTALLED_APP_ACTION_URLS.retry },
      };
    case "unavailable":
      return {
        title: "App can't open right now",
        body: "Check that Matrix is connected, then try again.",
        action: { label: "Retry", href: INSTALLED_APP_ACTION_URLS.retry },
      };
  }
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #242323; --muted: #6b6a6a; --button: #242323; --button-fg: #fafafa; }
@media (prefers-color-scheme: dark) { :root { --bg: #0e0e13; --fg: #ececf1; --muted: #9d9ca6; --button: #ececf1; --button-fg: #0e0e13; } }
html, body { height: 100%; margin: 0; }
body { display: grid; place-items: center; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
main { max-width: 360px; padding: 24px; text-align: center; }
h1 { margin: 0 0 8px; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
p { margin: 0 0 20px; color: var(--muted); }
a { display: inline-block; padding: 7px 16px; border-radius: 8px; background: var(--button); color: var(--button-fg);
  text-decoration: none; font-weight: 500; }
`;

/** A `data:` URL for the given state; the app name is owner-controlled and always escaped. */
export function installedAppStatePage(kind: InstalledAppStateKind, appName: string): string {
  const copy = copyFor(kind, appName);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
    + `<title>${escapeHtml(appName)}</title><style>${STYLE}</style></head><body><main>`
    + `<h1>${escapeHtml(copy.title)}</h1>`
    + (copy.body ? `<p>${escapeHtml(copy.body)}</p>` : "")
    + (copy.action ? `<a href="${copy.action.href}">${escapeHtml(copy.action.label)}</a>` : "")
    + `</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
