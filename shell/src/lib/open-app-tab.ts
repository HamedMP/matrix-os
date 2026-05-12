import { openAppSession } from "@/lib/app-session";
import { buildBrowserStandaloneAppUrl } from "@/lib/proxy-routes";

function extractTopLevelAppSlug(path: string): string | null {
  const match = path.match(/^apps\/([a-z0-9][a-z0-9-]{0,63})(?:\/(?:index\.html)?)?$/);
  return match ? match[1] : null;
}

function getStandaloneAppUrl(path: string): { url: string; slug: string | null } | null {
  if (path.startsWith("__")) return null;
  if (path === "apps/browser" || path === "apps/browser/index.html") {
    return { url: buildBrowserStandaloneAppUrl(undefined), slug: "browser" };
  }
  const slug = extractTopLevelAppSlug(path);
  if (slug) return { url: `/apps/${slug}/`, slug };
  return { url: `/files/${path}`, slug: null };
}

export function openAppInStandaloneTab(path: string): void {
  const target = getStandaloneAppUrl(path);
  if (!target) return;

  const tab = window.open("about:blank", "_blank");
  if (!tab) return;
  tab.opener = null;

  if (!target.slug) {
    tab.location.href = target.url;
    return;
  }

  openAppSession(target.slug)
    .catch((err: unknown) => {
      console.warn(
        "[open-app-tab] session bootstrap failed:",
        target.slug,
        err instanceof Error ? err.message : String(err),
      );
    })
    .finally(() => {
      tab.location.href = target.url;
    });
}
