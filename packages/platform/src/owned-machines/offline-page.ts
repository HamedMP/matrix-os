import type { Context } from 'hono';
import { desktopFonts, desktopPalette } from '@matrix-os/brand/tokens';

function minutesAgo(lastSeenAt: string | null | undefined, now: number): string {
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  if (!Number.isFinite(seen)) return 'Not seen yet';
  const minutes = Math.max(1, Math.round((now - seen) / 60_000));
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Last seen ${hours} h ago`;
  return `Last seen ${Math.round(hours / 24)} days ago`;
}

export function ownedOfflinePage(lastSeenAt: string | null | undefined, now = Date.now()): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="30"><title>Computer offline -- Matrix OS</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: ${desktopPalette.paper};
    color: ${desktopPalette.forest}; font-family: ${desktopFonts.display}; }
  main { max-width: 440px; } h1 { font-size: 24px; margin: 0 0 8px; } p, li { color: ${desktopPalette.textMuted}; line-height: 1.5; }
  code { background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 6px; } a { color: inherit; }
</style></head>
<body><main>
  <h1>Your computer is offline</h1>
  <p>${minutesAgo(lastSeenAt, now)}. Matrix reconnects on its own when it comes back.</p>
  <ul>
    <li>Is it switched on, awake and connected to the internet?</li>
    <li>On the computer, run <code>sudo matrix-connect status</code>.</li>
  </ul>
  <p><a href="/runtime">Switch to another computer</a></p>
</main></body></html>`;
}

const API_PREFIXES = ['/api/', '/ws', '/files/', '/icons/', '/apps/', '/health'];

/** Owners see an explanation, never a raw 502, when their own computer is unreachable. */
export function ownedOfflineResponse(c: Context, path: string, lastSeenAt: string | null | undefined): Response {
  c.header('Cache-Control', 'no-store, private');
  c.header('CDN-Cache-Control', 'no-store');
  c.header('Retry-After', '30');
  if (API_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))) {
    return c.json({ error: 'computer_offline' }, 503);
  }
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return c.html(ownedOfflinePage(lastSeenAt), 503);
}
