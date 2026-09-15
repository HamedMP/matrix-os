// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWebProviderAgentSetup } from "../../shell/src/lib/provider-settings-transport.js";
import { openDesktopProviderAgentSetup } from "../../desktop/src/renderer/src/features/settings/provider-settings-desktop-adapter.js";

describe("Settings catalog connection-label negotiation", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("opts Web Settings into labels while requesting a fresh catalog", async () => {
    const fetcher = vi.fn(async () => Response.json({ revision: "revision", drivers: [], instances: [] }));
    vi.stubGlobal("fetch", fetcher);
    expect(await openWebProviderAgentSetup("pi", vi.fn())).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/chat-providers?refresh=true&includeConnectionLabels=true"), expect.any(Object));
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("opts Electron Settings into labels without losing bounded response and timeout", async () => {
    const api = { get: vi.fn(async () => ({ revision: "revision", drivers: [], instances: [] })) };
    expect(await openDesktopProviderAgentSetup(api as never, "pi", () => true)).toBe(false);
    expect(api.get).toHaveBeenCalledWith("/api/chat-providers?refresh=true&includeConnectionLabels=true",
      expect.objectContaining({ maxBytes: 1024 * 1024, signal: expect.any(AbortSignal) }));
    expect(api.get).toHaveBeenCalledOnce();
  });
});
