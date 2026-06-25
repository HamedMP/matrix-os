import { EventEmitter } from "node:events";
import { net } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedService } from "@desktop/main/embeds/embed-service";
import type { Bounds } from "@desktop/main/embeds/embed-manager";
import type { HandoffResult } from "@desktop/main/embeds/app-session";

vi.mock("electron", () => ({
  net: { request: vi.fn() },
  session: { fromPartition: vi.fn() },
}));

const BOUNDS: Bounds = { x: 0, y: 0, width: 800, height: 600 };

describe("EmbedService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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
      performHostedShellHandoff: (gatewayOrigin: string) => Promise<HandoffResult>;
      scheduleHostedShellSessionRefresh: (gatewayOrigin: string) => void;
      manager: { open: (kind: string, slug: string | null, bounds: Bounds, url: string, options: { active?: boolean }) => string };
    };
    const open = vi.spyOn(internals.manager, "open").mockReturnValue("embed-shell");
    vi.spyOn(internals, "scheduleHostedShellSessionRefresh").mockImplementation(() => {});
    let resolveHandoff!: (result: HandoffResult) => void;
    vi.spyOn(internals, "performHostedShellHandoff").mockImplementation(
      () => new Promise((resolve) => { resolveHandoff = resolve; }),
    );

    internals.pendingHostedShells.set("embed-shell", BOUNDS);
    const retry = service.retryAuth("embed-shell");
    expect(service.setActive("embed-shell", false)).toBe(true);

    resolveHandoff({ ok: true });
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

  it("schedules hosted-shell session refresh from the app-session cookie expiry", async () => {
    vi.useFakeTimers();
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      hostedShellIds: Set<string>;
      scheduleHostedShellSessionRefresh: (gatewayOrigin: string) => void;
      readHostedShellRefreshDelay: () => Promise<number>;
      refreshHostedShellSession: (gatewayOrigin: string) => Promise<HandoffResult>;
    };
    const refresh = vi
      .spyOn(internals, "refreshHostedShellSession")
      .mockResolvedValue({ ok: true });
    vi.spyOn(internals, "readHostedShellRefreshDelay").mockResolvedValue(120_000);

    internals.hostedShellIds.add("embed-shell");
    internals.scheduleHostedShellSessionRefresh("https://gateway.test");
    await vi.runAllTicks();

    await vi.advanceTimersByTimeAsync(119_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledWith("https://gateway.test");
  });

  it("retries transient hosted-shell refresh failures without marking auth required", async () => {
    vi.useFakeTimers();
    const emitState = vi.fn();
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState,
    });
    const internals = service as unknown as {
      hostedShellIds: Set<string>;
      refreshHostedShellSession: (gatewayOrigin: string) => Promise<HandoffResult>;
      performHostedShellHandoff: (gatewayOrigin: string) => Promise<HandoffResult>;
    };
    vi.spyOn(internals, "performHostedShellHandoff").mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });
    internals.hostedShellIds.add("embed-shell");

    await expect(internals.refreshHostedShellSession("https://gateway.test")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(emitState).not.toHaveBeenCalledWith("embed-shell", "auth-required");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(internals.performHostedShellHandoff).toHaveBeenCalledTimes(2);
  });

  it("emits auth-required and stops refreshing on hosted-shell auth failure", async () => {
    vi.useFakeTimers();
    const emitState = vi.fn();
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState,
    });
    const internals = service as unknown as {
      hostedShellIds: Set<string>;
      refreshHostedShellSession: (gatewayOrigin: string) => Promise<HandoffResult>;
      performHostedShellHandoff: (gatewayOrigin: string) => Promise<HandoffResult>;
    };
    vi.spyOn(internals, "performHostedShellHandoff").mockResolvedValue({
      ok: false,
      reason: "auth",
    });
    internals.hostedShellIds.add("embed-shell");

    await expect(internals.refreshHostedShellSession("https://gateway.test")).resolves.toEqual({
      ok: false,
      reason: "auth",
    });
    expect(emitState).toHaveBeenCalledWith("embed-shell", "auth-required");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(internals.performHostedShellHandoff).toHaveBeenCalledTimes(1);
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
