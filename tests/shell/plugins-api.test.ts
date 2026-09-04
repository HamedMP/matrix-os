import { describe, expect, it, vi } from "vitest";
import { pluginKeys, pluginsQueryOptions } from "@/api/plugins";

describe("pluginsQueryOptions", () => {
  it("uses the domain-owned key and forwards Query cancellation to its fetcher", async () => {
    const listPlugins = vi.fn().mockResolvedValue([]);
    const options = pluginsQueryOptions(listPlugins);
    const controller = new AbortController();

    await options.queryFn!({
      client: {} as never,
      queryKey: options.queryKey,
      signal: controller.signal,
      meta: undefined,
    });

    expect(options.queryKey).toEqual(pluginKeys.list());
    expect(listPlugins).toHaveBeenCalledWith({ signal: controller.signal });
  });
});
