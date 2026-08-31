import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { appKeys, appsQueryOptions, listApps } from "../../shell/src/api/apps";

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

  it("uses one stable cache key and forwards Query cancellation", async () => {
    const loader = vi.fn(async () => []);
    const options = appsQueryOptions(loader);
    const controller = new AbortController();

    expect(options.queryKey).toEqual(appKeys.list());
    await options.queryFn?.({ signal: controller.signal } as never);
    expect(loader).toHaveBeenCalledWith({ signal: controller.signal });
  });

  it("keeps a regenerated icon URL when a catalog refetch omits icon metadata", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(appKeys.list(), [{
      name: "Notes",
      path: "/files/apps/notes/index.html",
      slug: "notes",
      iconUrl: "/icons/notes.png?v=generated",
    }]);

    await queryClient.fetchQuery(appsQueryOptions(async () => [{
      name: "Fresh Notes",
      path: "/files/apps/notes/index.html",
      slug: "notes",
    }]));

    expect(queryClient.getQueryData(appKeys.list())).toEqual([{
      name: "Fresh Notes",
      path: "/files/apps/notes/index.html",
      slug: "notes",
      iconUrl: "/icons/notes.png?v=generated",
    }]);

    await queryClient.fetchQuery(appsQueryOptions(async () => [{
      name: "Fresh Notes",
      path: "/files/apps/notes/index.html",
      slug: "notes",
      iconUrl: "/icons/notes.png?v=server",
    }]));

    expect(queryClient.getQueryData(appKeys.list())).toEqual([expect.objectContaining({
      iconUrl: "/icons/notes.png?v=server",
    })]);
  });
});
