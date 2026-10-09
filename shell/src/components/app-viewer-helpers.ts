import { buildBridgeScript, withCredentialedAssets, type ThemeVars } from "@/lib/os-bridge";
import { appRuntimeSlugFromIdentity } from "@matrix-os/contracts";

const LEGACY_NESTED_RUNTIME_APP_SLUGS = new Set([
  "2048",
  "backgammon",
  "chess",
  "minesweeper",
  "snake",
  "solitaire",
  "tetris",
]);

export const APP_IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups";

const APP_IFRAME_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join("; ");

export function appIdentityFromPath(path: string): string {
  if (path.startsWith("modules/")) return path.split("/")[1];
  return path.replace(/^apps\//, "").replace(/\/(?:dist\/)?index\.html$/, "").replace(/\.html$/, "").replace(/\/$/, "");
}

/** The gateway's legacy database namespace strips separators; leaf identities do not match. */
export function isAppDataChangeForIdentity(identity: string, changedApp: string): boolean {
  return changedApp === identity || changedApp === identity.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function appDataChangeMessageForIdentity(identity: string, changedApp: string, key: string) {
  return isAppDataChangeForIdentity(identity, changedApp)
    ? { type: "os:data-change", payload: { app: identity, key } }
    : null;
}

export function extractSlug(path: string): string | null {
  const topLevel = path.match(/^apps\/([a-z0-9][a-z0-9-]{0,63})(?:\/(?:index\.html)?)?$/);
  if (topLevel) return topLevel[1];

  // Older saved layouts used filesystem paths for migrated bundled games. Only
  // rewrite known migrated slugs; other nested paths still load as files.
  const nestedIndex = path.match(/^apps\/games\/([a-z0-9][a-z0-9-]{0,63})\/index\.html$/);
  if (nestedIndex && LEGACY_NESTED_RUNTIME_APP_SLUGS.has(nestedIndex[1])) {
    return appRuntimeSlugFromIdentity(appIdentityFromPath(path));
  }
  return null;
}

export function shouldRenderAppIframe(path: string): boolean {
  return !path.startsWith("__");
}

export function injectBridgeIntoAppHtml(
  html: string,
  appName: string,
  themeVars: ThemeVars,
  baseHref: string,
  design?: string,
): string {
  const bridgeScript = buildBridgeScript(appName, themeVars, design)
    + `\n;if(window.MatrixOS&&window.MatrixOS.db){useDb=true;}if(typeof loadData==="function"){loadData();}\n`;
  const escapedBaseHref = baseHref.replace(/"/g, "&quot;");
  const injection = [
    `<base href="${escapedBaseHref}">`,
    `<meta http-equiv="Content-Security-Policy" content="${APP_IFRAME_CSP.replace(/"/g, "&quot;")}">`,
    `<script>${bridgeScript}</script>`,
  ].join("");

  const rewritten = withCredentialedAssets(html);

  if (/<head[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<head([^>]*)>/i, `<head$1>${injection}`);
  }
  return `<!doctype html><html><head>${injection}</head><body>${rewritten}</body></html>`;
}
