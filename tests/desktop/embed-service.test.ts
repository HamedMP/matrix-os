import { EventEmitter } from "node:events";
import { net } from "electron";
import { describe, expect, it, vi } from "vitest";
import { EmbedService } from "@desktop/main/embeds/embed-service";
import type { Bounds } from "@desktop/main/embeds/embed-manager";

vi.mock("electron", () => ({
  net: { request: vi.fn() },
  session: { fromPartition: vi.fn() },
}));

const BOUNDS: Bounds = { x: 0, y: 0, width: 800, height: 600 };

describe("EmbedService", () => {
  it("honors pending hosted-shell inactive state when retry auth finishes", async () => {
    const emitState = vi.fn();
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState,
    });
    const internals = service as unknown as {
      pendingHostedShells: Map<string, Bounds>;
      performHostedShellHandoff: (gatewayOrigin: string) => Promise<boolean>;
      manager: { open: (kind: string, slug: string | null, bounds: Bounds, url: string, options: { active?: boolean }) => string };
    };
    const open = vi.spyOn(internals.manager, "open").mockReturnValue("embed-shell");
    let resolveHandoff!: (ok: boolean) => void;
    vi.spyOn(internals, "performHostedShellHandoff").mockImplementation(
      () => new Promise((resolve) => { resolveHandoff = resolve; }),
    );

    internals.pendingHostedShells.set("embed-shell", BOUNDS);
    const retry = service.retryAuth("embed-shell");
    expect(service.setActive("embed-shell", false)).toBe(true);

    resolveHandoff(true);
    await expect(retry).resolves.toBe(true);

    expect(open).toHaveBeenCalledWith(
      "hosted-shell",
      null,
      BOUNDS,
      "https://gateway.test/",
      expect.objectContaining({ id: "embed-shell", active: false }),
    );
    expect(emitState).toHaveBeenCalledWith("embed-shell", "loading");
  });

  it("rejects gateway requests when the response stream errors", async () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const response = Object.assign(new EventEmitter(), {
      headers: {},
      statusCode: 200,
    });
    const request = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      abort: vi.fn(),
      end: vi.fn(() => {
        request.emit("response", response);
        response.emit("error", new Error("stream reset"));
      }),
    });
    vi.mocked(net.request).mockReturnValue(request as never);
    const internals = service as unknown as {
      gatewayRequest: (
        url: string,
        init: { method: string; headers: Record<string, string>; body: string },
      ) => Promise<{ status: number; setCookieHeaders: string[]; body: string }>;
    };

    await expect(
      internals.gatewayRequest("https://gateway.test/api/apps/notes/session-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow("stream reset");
  });

  it("keeps retry auth recoverable when a pending app launch url fails origin checks", async () => {
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchLaunchToken = vi.spyOn(internals, "fetchLaunchToken");
    fetchLaunchToken
      .mockResolvedValueOnce({
        launchUrl: "https://evil.test/apps/notes/",
        expiresAt: Date.now() + 60_000,
      })
      .mockResolvedValueOnce({
        launchUrl: "/apps/notes/",
        expiresAt: Date.now() + 60_000,
      });

    internals.pendingApps.set("embed-app", { slug: "notes", bounds: BOUNDS });

    await expect(service.retryAuth("embed-app")).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(emitState).toHaveBeenCalledWith("embed-app", "auth-required");

    await expect(service.retryAuth("embed-app")).resolves.toBe(true);
    expect(fetchLaunchToken).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(
      "app",
      "notes",
      BOUNDS,
      "https://gateway.test/apps/notes/",
      expect.objectContaining({ id: "embed-app" }),
    );
  });

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
