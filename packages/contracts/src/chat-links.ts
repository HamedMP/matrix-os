import { safeRelativePath } from "#legacy-contract-primitives";
import { normalizeOsViewDesktopAppPath } from "./os-view.js";

const PathSchema = safeRelativePath();

/** Only catalog-backed app roots and entry points are launch references. */
export function resolveChatAppReference<T extends { slug: string; path?: string }>(
  input: string,
  apps: readonly T[],
  options: { allowRelative?: boolean } = {},
): T | null {
  if (options.allowRelative === false && !/^(?:~\/|\/home\/matrix\/home\/|\/files\/|file:\/\/\/home\/matrix\/home\/)/i.test(input.trim())) return null;
  const target = resolveChatMessageLink(input.replace(/\/+$/, ""));
  if (target?.kind !== "file" || !target.path.startsWith("apps/")) return null;
  for (const app of apps) {
    if (!app.path) continue;
    const catalogPath = normalizeOsViewDesktopAppPath(app.path);
    const entryPath = target.path.endsWith("/index.html") ? target.path : `${target.path}/index.html`;
    if (catalogPath.startsWith("__") && normalizeOsViewDesktopAppPath(entryPath) === catalogPath) return app;
    if (!catalogPath.startsWith("apps/") || !catalogPath.endsWith("/index.html")) continue;
    const root = catalogPath.replace(/\/(?:dist\/)?index\.html$/, "");
    if (target.path === root || target.path === `${root}/index.html` || target.path === `${root}/dist/index.html`) return app;
  }
  return null;
}
export function resolveChatMessageLink(input: string): { kind: "file"; path: string } | { kind: "web"; url: string } | null {
  if (input.length > 4096) return null;
  let value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.username || url.password ? null : { kind: "web", url: url.href };
    } catch (error: unknown) {
      if (error instanceof TypeError) return null;
      throw error;
    }
  }
  try { value = decodeURIComponent(value); }
  catch (error: unknown) { if (error instanceof URIError) return null; throw error; }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^file:\/\/\//i.test(value)) return null;
  value = value.replace(/^file:\/\//i, "").replace(/:\d+(?::\d+)?$/, "");
  if (value.startsWith("/home/matrix/home/")) value = value.slice(18);
  else if (value.startsWith("~/") || value.startsWith("./")) value = value.slice(2);
  else if (value.startsWith("/files/")) value = value.slice(7);
  else if (value.startsWith("/")) return null;
  const parsed = PathSchema.safeParse(value);
  return parsed.success ? { kind: "file", path: parsed.data } : null;
}
