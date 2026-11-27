// `matrixos://app/<installId>` opens an installed app's window. Like the
// shared-app link router, at most one link is held until the opener is ready.
import { InstallIdSchema } from "./record";

const INSTALLED_APP_DEEP_LINK_HOST = "app";

function parseUrl(value: string): URL | null {
  return URL.canParse(value) ? new URL(value) : null;
}

function isInstalledAppHost(url: URL, schemes: readonly string[]): boolean {
  return schemes.some((scheme) => url.protocol === `${scheme}:`)
    && url.hostname === INSTALLED_APP_DEEP_LINK_HOST;
}

/** The install id of a valid installed-app link, lower-cased; null for anything else. */
export function parseInstalledAppDeepLink(value: string, schemes: readonly string[]): string | null {
  const url = parseUrl(value);
  if (!url || !isInstalledAppHost(url, schemes)) return null;
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  const parsed = InstallIdSchema.safeParse(segments[0]!.toLowerCase());
  return parsed.success ? parsed.data : null;
}

export function createInstalledAppDeepLinks(options: { schemes: readonly string[] }) {
  let pending: string | null = null;
  let open: ((installId: string) => void) | null = null;
  return {
    /** True when `url` targets the installed-app host (opened, held, or rejected). */
    handle(url: string): boolean {
      const parsed = parseUrl(url);
      if (!parsed || !isInstalledAppHost(parsed, options.schemes)) return false;
      const installId = parseInstalledAppDeepLink(url, options.schemes);
      if (!installId) {
        console.warn("[installed-apps] ignored an invalid app link");
        return true;
      }
      if (open) open(installId);
      else pending = installId;
      return true;
    },
    /** Install records and auth are loaded: open the held link, then open links directly. */
    ready(opener: (installId: string) => void): void {
      open = opener;
      const held = pending;
      pending = null;
      if (held) opener(held);
    },
    detach(): void {
      open = null;
    },
  };
}
