import { canonicalOsViewCatalogPath } from "@matrix-os/contracts";
import { extractSlug } from "@/components/app-viewer-helpers";

type CatalogApp = { path?: unknown; file?: unknown; slug?: unknown };
const SAFE_MANIFEST_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Physical owner folders are catalog references, not runtime/grant identities. */
export function catalogAppLaunchPath(app: CatalogApp): string | null {
  const path = canonicalOsViewCatalogPath(app);
  if (!path) return null;
  const slug = typeof app.slug === "string" && SAFE_MANIFEST_SLUG.test(app.slug) ? app.slug : null;
  // Preserve legacy files and the explicitly supported bundled game migrations.
  return !slug || !path.startsWith("apps/") || extractSlug(path) === slug
    ? path : `apps/${slug}/index.html`;
}

/** Bounded per-bootstrap lookup; its maps are released when restoration settles. */
export function createCatalogAppPathResolver(apps: readonly CatalogApp[] | undefined): (path: string) => string {
  const relative = (path: string) => path.replace(/^\/files\//, "");
  if (!apps || apps.length > 10_000) return relative;
  // Each map has at most one entry per row in the bounded catalog. Duplicate
  // references are marked ambiguous, never resolved by iteration order.
  const physical = new Map<string, string | null>();
  const canonical = new Map<string, string | null>();
  for (const app of apps) {
    const owner = canonicalOsViewCatalogPath(app);
    const launch = catalogAppLaunchPath(app);
    if (!owner || !launch) continue;
    physical.set(owner, physical.has(owner) ? null : launch);
    canonical.set(launch, canonical.has(launch) ? null : launch);
  }
  return path => {
    const key = relative(path);
    // Persisted runtime identities take priority over a subsequently reused folder.
    return (canonical.has(key) ? canonical.get(key) : physical.get(key)) ?? key;
  };
}
