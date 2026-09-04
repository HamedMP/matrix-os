import { describe, expect, it, vi } from "vitest";
import { cronKeys, cronQueryOptions } from "@desktop/renderer/src/features/settings/cron.api";

describe("cronQueryOptions", () => {
  it("scopes a cron query and forwards Query cancellation to the desktop transport", async () => {
    const api = { get: vi.fn().mockResolvedValue({ jobs: [] }) };
    const scope = { platformHost: "https://app.matrix-os.com", authGeneration: 3, runtimeSlot: "work" };
    const options = cronQueryOptions(api as never, scope);
    const controller = new AbortController();

    await options.queryFn!({
      client: {} as never,
      queryKey: options.queryKey,
      signal: controller.signal,
      meta: undefined,
    });

    expect(options.queryKey).toEqual(cronKeys.list(scope));
    expect(api.get).toHaveBeenCalledWith("/api/cron", { signal: controller.signal });
  });
});
