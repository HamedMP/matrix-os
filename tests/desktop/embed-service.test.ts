import { describe, expect, it, vi } from "vitest";
import { EmbedService } from "@desktop/main/embeds/embed-service";
import type { Bounds } from "@desktop/main/embeds/embed-manager";

vi.mock("electron", () => ({
  net: { request: vi.fn() },
  session: { fromPartition: vi.fn() },
}));

const BOUNDS: Bounds = { x: 0, y: 0, width: 800, height: 600 };

describe("EmbedService", () => {
  it("does not attach a pending app after it closes during retry auth", async () => {
    const emitState = vi.fn();
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState,
    });
    const internals = service as unknown as {
      pendingApps: Map<string, { slug: string; bounds: Bounds }>;
      fetchLaunchToken: (gatewayOrigin: string, slug: string) => Promise<{ launchUrl: string; expiresAt: number } | null>;
      manager: { open: (kind: string, slug: string | null, bounds: Bounds, url: string, options: unknown) => string };
    };
    const open = vi.spyOn(internals.manager, "open").mockReturnValue("embed-app");
    let resolveToken!: (token: { launchUrl: string; expiresAt: number }) => void;
    vi.spyOn(internals, "fetchLaunchToken").mockImplementation(
      () => new Promise((resolve) => { resolveToken = resolve; }),
    );

    internals.pendingApps.set("embed-app", { slug: "notes", bounds: BOUNDS });
    const retry = service.retryAuth("embed-app");
    expect(service.close("embed-app")).toBe(true);
    resolveToken({ launchUrl: "/apps/notes/", expiresAt: Date.now() + 60_000 });

    await expect(retry).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(emitState).not.toHaveBeenCalledWith("embed-app", "loading");
  });
});
