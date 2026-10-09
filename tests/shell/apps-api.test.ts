import { catalogAppLaunchPath, createCatalogAppPathResolver } from "../../shell/src/lib/app-catalog-launch";
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { appKeys, appsQueryOptions, listApps, resolveCatalogIconUrl, hydrateAppIconUrls } from "../../shell/src/api/apps";

describe("web app catalog query", () => {
  it("keeps the complete validated catalog", async () => {
    const catalog = Array.from({ length: 201 }, (_, index) => ({
      name: `App ${index}`,
      path: `/files/apps/app-${index}/index.html`,
      slug: `app-${index}`,
    }));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(listApps()).resolves.toHaveLength(201);
    fetch.mockRestore();
  });

  it("keeps catalog icon URLs that point at gateway-owned versioned icons", async () => {
    const catalog = [
      {
        name: "Custom Dashboard",
        path: "/files/apps/custom-dashboard/index.html",
        slug: "custom-dashboard",
        icon: "custom-brand",
        iconUrl: "/icons/custom-brand.png?v=mtime-size",
      },
      {
        name: "Tracker",
        path: "/files/apps/tracker/index.html",
        slug: "tracker",
        iconUrl: "https://tracking.invalid/icon.png",
      },
    ];
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const apps = await listApps();
    expect(apps[0]?.iconUrl).toBe("/icons/custom-brand.png?v=mtime-size");
    expect(apps[1]).not.toHaveProperty("iconUrl");
    fetch.mockRestore();
  });

  it("binds versioned catalog icon paths to the current gateway and rejects other URLs", () => {
    const resolve = (path: string) => `https://app.test/vm/alpha${path}`;

    expect(resolveCatalogIconUrl("/icons/custom-brand.png?v=mtime-size", resolve)).toBe(
      "https://app.test/vm/alpha/icons/custom-brand.png?v=mtime-size",
    );
    expect(resolveCatalogIconUrl("/icons/game.svg", resolve)).toBe("https://app.test/vm/alpha/icons/game.svg");
    expect(resolveCatalogIconUrl("https://tracking.invalid/icon.png", resolve)).toBeUndefined();
    expect(resolveCatalogIconUrl("/icons/../system/secret.png", resolve)).toBeUndefined();
    expect(resolveCatalogIconUrl("/files/system/icons/notes.png", resolve)).toBeUndefined();
    expect(resolveCatalogIconUrl(42, resolve)).toBeUndefined();
  });

  it("uses one stable cache key and forwards Query cancellation", async () => {
    const loader = vi.fn(async () => []);
    const options = appsQueryOptions(loader);
    const controller = new AbortController();

    expect(options.queryKey).toEqual(appKeys.list());
    await options.queryFn?.({ signal: controller.signal } as never);
    expect(loader).toHaveBeenCalledWith({ signal: controller.signal });
  });

  it("keeps a regenerated icon URL only while the icon identity is unchanged", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(appKeys.list(), [{
      name: "Notes",
      path: "/files/apps/notes/index.html",
      slug: "notes",
      icon: "notes",
      iconUrl: "/icons/notes.png?v=generated",
    }]);

    await queryClient.fetchQuery(appsQueryOptions(async () => [{
      name: "Fresh Notes",
      path: "/files/apps/notes/index.html",
      slug: "notes",
      icon: "notes",
    }]));

    expect(queryClient.getQueryData(appKeys.list())).toEqual([{
      name: "Fresh Notes",
      path: "/files/apps/notes/index.html",
      slug: "notes",
      icon: "notes",
      iconUrl: "/icons/notes.png?v=generated",
    }]);

    await queryClient.fetchQuery(appsQueryOptions(async () => [{
      name: "Fresh Notes",
      path: "/files/apps/notes/index.html",
      slug: "notes",
      icon: "notes-redesign",
    }]));

    expect(queryClient.getQueryData(appKeys.list())).toEqual([{
      name: "Fresh Notes",
      path: "/files/apps/notes/index.html",
      slug: "notes",
      icon: "notes-redesign",
    }]);

    await queryClient.fetchQuery(appsQueryOptions(async () => [{
      name: "Fresh Notes",
      path: "/files/apps/notes/index.html",
      slug: "notes",
      icon: "notes-redesign",
      iconUrl: "/icons/notes.png?v=server",
    }]));

    expect(queryClient.getQueryData(appKeys.list())).toEqual([expect.objectContaining({
      iconUrl: "/icons/notes.png?v=server",
    })]);
  });
});


describe("bundled app artwork refresh", () => {
  it.each(["notes", "whiteboard"])("keeps current %s artwork after catalog refresh and snapshot hydration", async (slug) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([{
      name: slug, path: `/files/apps/${slug}/index.html`, slug, icon: slug,
      iconUrl: `/system-app-icons/v2/${slug}.png`,
    }]), { status: 200, headers: { "Content-Type": "application/json" } }));
    try {
      const apps = await listApps();
      expect(apps[0]?.iconUrl).toBe(`/system-app-icons/v2/${slug}.png`);
      expect(hydrateAppIconUrls(apps, { [slug]: { versionedUrl: `/icons/${slug}.png?v=old` } }, p => p)?.[0]?.iconUrl).toBe(`/system-app-icons/v2/${slug}.png`);
    } finally { fetch.mockRestore(); }
  });
  it("scopes only canonical bundled artwork to the selected computer", () => {
    const resolve = (p: string) => `https://app.test/vm/preview/~runtime/preview${p}`;
    expect(resolveCatalogIconUrl("/system-app-icons/v2/notes.png", resolve)).toBe("https://app.test/vm/preview/~runtime/preview/system-app-icons/v2/notes.png");
    for (const path of ["/system-app-icons/v2/../secret.png", "/system-app-icons/v2/notes.svg", "/system-app-icons/v3/notes.png", "/system-app-icons/v2/notes.png?token=secret"]) {
      expect(resolveCatalogIconUrl(path, resolve)).toBeUndefined();
    }
  });
});


it("binds selected bootstrap artwork to the active computer before legacy snapshot fallback", () => {
  const resolve = (path: string) => `https://app.test/vm/current${path}`;
  const apps = [{ name: "Notes", path: "apps/notes/index.html", icon: "notes", iconUrl: "/system-app-icons/v2/notes.png" }];
  expect(hydrateAppIconUrls(apps, { notes: { versionedUrl: "/icons/notes.png?v=old" } }, resolve)?.[0]?.iconUrl).toBe("https://app.test/vm/current/system-app-icons/v2/notes.png");
});


it.each(["renamed-ledger", "finance/ledger", "My Finance/Owner Ledger"])("uses the stable manifest launch path for the catalog and cached owner folder %s", async folder => {
  const row = { name: "Ledger", path: `/files/apps/${folder}/index.html`, slug: "folio", iconUrl: "/icons/folio.png?v=owner" };
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([row]));
  try {
    expect((await listApps())[0]?.path).toBe("apps/folio/index.html");
    expect(hydrateAppIconUrls([row], undefined, p => p)?.[0]).toMatchObject({ path: "apps/folio/index.html", iconUrl: row.iconUrl });
  } finally { fetch.mockRestore(); }
});


it("preserves supported game migrations and legacy file apps without inventing identities", () => {
  expect(catalogAppLaunchPath({ slug: "2048", file: "games/2048/index.html" })).toBe("apps/games/2048/index.html");
  expect(catalogAppLaunchPath({ path: "apps/legacy.html" })).toBe("apps/legacy.html");
  expect(catalogAppLaunchPath({ path: "apps/legacy/index.html" })).toBe("apps/legacy/index.html");
  expect(catalogAppLaunchPath({ slug: "bad/identity", path: "apps/legacy/index.html" })).toBe("apps/legacy/index.html");
  expect(catalogAppLaunchPath({ slug: "folio", path: "../private/index.html" })).toBeNull();
  const ambiguous = createCatalogAppPathResolver([{ slug: "first", path: "apps/renamed/index.html" }, { slug: "second", path: "apps/renamed/index.html" }]);
  expect(ambiguous("apps/renamed/index.html")).toBe("apps/renamed/index.html");
  const unknown = createCatalogAppPathResolver([{ slug: "folio", path: "apps/renamed/index.html" }]);
  expect(unknown("apps/unknown/index.html")).toBe("apps/unknown/index.html");
});
