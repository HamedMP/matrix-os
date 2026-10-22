import { describe, expect, it, vi } from "vitest";
import { EmbedService } from "@desktop/main/embeds/embed-service";
vi.mock("electron", () => ({ net: { request: vi.fn() }, session: { fromPartition: vi.fn() } }));
describe("native product app launch wiring", () => {
  it("mints distinct one-use launch tokens for Browser and Cloud desktop and preserves the shared lab route", async () => {
    const service = new EmbedService({ getWindow: () => null, getGatewayOrigin: () => "https://gateway.test", getToken: () => "synthetic", emitState: vi.fn() });
    const internals = service as unknown as { fetchLaunchToken(origin: string, slug: string): Promise<{ launchUrl: string; expiresAt: number }>;
      manager: { open(...args: unknown[]): string }; };
    let count = 0;
    const fetchToken = vi.spyOn(internals, "fetchLaunchToken").mockImplementation(async () => ({ launchUrl: `/apps/browser-lab/?session=synthetic-${++count}`, expiresAt: Date.now() + 60_000 }));
    const open = vi.spyOn(internals.manager, "open").mockReturnValue("view");
    const bounds = { x: 0, y: 0, width: 900, height: 600 };
    await service.open({ kind: "app", slug: "browser-lab", appIdentity: "matrix-browser", bounds });
    await service.open({ kind: "app", slug: "browser-lab", appIdentity: "matrix-cloud-desktop", bounds });
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(open.mock.calls.map(call => call[3])).toEqual([
      "https://gateway.test/apps/browser-lab/?session=synthetic-1&surface=browser",
      "https://gateway.test/apps/browser-lab/?session=synthetic-2&surface=desktop",
    ]);
    expect(open.mock.calls.map(call => call[4])).toEqual([expect.objectContaining({ routeSlug: "browser-lab" }), expect.objectContaining({ routeSlug: "browser-lab" })]);
    service.closeAll();
  });
});
