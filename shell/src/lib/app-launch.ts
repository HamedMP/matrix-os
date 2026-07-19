import { gatewayAssetUrl } from "./gateway";

export const SAFE_APP_SLUG = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const SAFE_ICON_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const APP_RASTER_ICON_SLUGS = new Set([
  "2048",
  "backgammon",
  "calculator",
  "chat",
  "chess",
  "clock",
  "code",
  "expense-tracker",
  "files",
  "game-center",
  "minesweeper",
  "notes",
  "pomodoro-timer",
  "profile",
  "snake",
  "social",
  "solitaire",
  "task-manager",
  "terminal",
  "tetris",
  "todo",
  "weather",
  "whiteboard",
  "workspace",
]);

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
  "grid",
  "globe",
  "layers",
  "mail",
  "messages",
  "music",
  "search",
  "settings",
  "terminal",
  "whiteboard",
  "workspace",
]);

const ICON_SLUG_ALIASES = new Map<string, string>([
  ["pomodoro", "pomodoro-timer"],
]);

export interface GatewayAppEntryLike {
  path?: string;
  slug?: string;
  launchUrl?: string;
}

export function iconUrlForSlug(slug: string | undefined): string | undefined {
  if (!slug || !SAFE_ICON_SLUG.test(slug)) return undefined;
  const iconSlug = ICON_SLUG_ALIASES.get(slug) ?? slug;
  const extension = APP_RASTER_ICON_SLUGS.has(iconSlug) || !SHIPPED_SVG_ICON_SLUGS.has(iconSlug) ? "png" : "svg";
  return gatewayAssetUrl(`/icons/${encodeURIComponent(iconSlug)}.${extension}`);
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

export function terminalContextLaunchPath(_projectSlug: string | null | undefined): string {
  return "__terminal__";
}
