import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { appKeys, appsQueryOptions, listApps, resolveCatalogIconUrl } from "../../shell/src/api/apps";

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
