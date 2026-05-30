export const SAFE_APP_SLUG = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const SAFE_ICON_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const SHIPPED_SVG_ICON_SLUGS = new Set([
  "calendar",
  "camera",
  "chart",
  "chat",
  "code",
  "document",
  "files",
  "folder",
  "game",
  "globe",
  "mail",
  "music",
  "search",
  "settings",
  "terminal",
  "whiteboard",
  "workspace",
]);

export interface GatewayAppEntryLike {
  path?: string;
  slug?: string;
  launchUrl?: string;
}

export function iconUrlForSlug(slug: string | undefined): string | undefined {
  if (!slug || !SAFE_ICON_SLUG.test(slug)) return undefined;
  const extension = SHIPPED_SVG_ICON_SLUGS.has(slug) ? "svg" : "png";
  return `/icons/${encodeURIComponent(slug)}.${extension}`;
}

export function canAutoGenerateIconForSlug(slug: string | undefined): boolean {
  return Boolean(slug && SAFE_ICON_SLUG.test(slug) && !SHIPPED_SVG_ICON_SLUGS.has(slug));
}

function slugFromLaunchUrl(launchUrl: string | undefined): string | null {
  if (!launchUrl) return null;
  try {
    const url = new URL(launchUrl, "http://matrix.local");
    const match = url.pathname.match(/^\/apps\/([a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*)\/?$/);
    return match ? match[1] : null;
  } catch (_err: unknown) {
    return null;
  }
}

export function canonicalAppLaunchPath(app: GatewayAppEntryLike): string | null {
  const slug = app.slug && SAFE_APP_SLUG.test(app.slug)
    ? app.slug
    : slugFromLaunchUrl(app.launchUrl);
  if (slug) {
    return `apps/${slug}/index.html`;
  }

  if (!app.path) return null;
  return app.path.replace(/^\/files\//, "");
}

export function terminalContextLaunchPath(projectSlug: string | null | undefined): string {
  if (!projectSlug || !SAFE_APP_SLUG.test(projectSlug)) return "__terminal__";
  return `__terminal__?project=${encodeURIComponent(projectSlug)}`;
}
