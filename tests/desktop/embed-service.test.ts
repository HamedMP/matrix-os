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

  it("reloads a live embed through the existing bounded manager", async () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      manager: { reload: (embedId: string) => boolean };
    };
    const reload = vi.spyOn(internals.manager, "reload").mockReturnValue(true);

    await expect(service.reload("embed-shell")).resolves.toBe(true);
    expect(reload).toHaveBeenCalledWith("embed-shell");
  });

  it("refreshes hosted-shell cookies before navigating the retained embed", async () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      hostedShellIds: Set<string>;
      refreshHostedShellSession: (gatewayOrigin: string) => Promise<HandoffResult>;
      manager: { reload: (embedId: string) => boolean };
    };
    let resolveRefresh!: (result: HandoffResult) => void;
    vi.spyOn(internals, "refreshHostedShellSession").mockImplementation(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );
    const reload = vi.spyOn(internals.manager, "reload").mockReturnValue(true);
    internals.hostedShellIds.add("embed-shell");

    const result = service.reload("embed-shell");
    expect(reload).not.toHaveBeenCalled();
    resolveRefresh({ ok: true });

    await expect(result).resolves.toBe(true);
    expect(reload).toHaveBeenCalledWith("embed-shell");
  });

  it("does not reuse or apply a stale hosted-shell handoff after runtime reset", async () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      hostedShellIds: Set<string>;
      performHostedShellHandoff: (gatewayOrigin: string) => Promise<HandoffResult>;
      scheduleHostedShellSessionRefresh: (gatewayOrigin: string) => void;
      manager: { reload: (embedId: string) => boolean };
    };
    const handoffResolvers: Array<(result: HandoffResult) => void> = [];
    const handoff = vi
      .spyOn(internals, "performHostedShellHandoff")
      .mockImplementation(
        () => new Promise((resolve) => { handoffResolvers.push(resolve); }),
      );
    const reload = vi.spyOn(internals.manager, "reload").mockReturnValue(true);
    vi.spyOn(internals, "scheduleHostedShellSessionRefresh").mockImplementation(() => {});

    internals.hostedShellIds.add("old-shell");
    const oldReload = service.reload("old-shell");

    service.closeAll();
    internals.hostedShellIds.add("new-shell");
    const newReload = service.reload("new-shell");

    expect(handoff).toHaveBeenCalledTimes(1);
    handoffResolvers[0]?.({ ok: true });
    await expect(oldReload).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalledWith("old-shell");

    await vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(2));
    handoffResolvers[1]?.({ ok: true });
    await expect(newReload).resolves.toBe(true);
    expect(reload).toHaveBeenCalledWith("new-shell");
  });

  it("does not attach a stale hosted-shell open after runtime reset", async () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      performHostedShellHandoff: (gatewayOrigin: string) => Promise<HandoffResult>;
      scheduleHostedShellSessionRefresh: (gatewayOrigin: string) => void;
      manager: {
        open: (
          kind: string,
          slug: string | null,
          bounds: Bounds,
          url: string,
          options: { id?: string },
        ) => string;
      };
    };
    const handoffResolvers: Array<(result: HandoffResult) => void> = [];
    const handoff = vi
      .spyOn(internals, "performHostedShellHandoff")
      .mockImplementation(
        () => new Promise((resolve) => { handoffResolvers.push(resolve); }),
      );
    const open = vi
      .spyOn(internals.manager, "open")
      .mockImplementation((_kind, _slug, _bounds, _url, options) => options.id ?? "missing");
    vi.spyOn(internals, "scheduleHostedShellSessionRefresh").mockImplementation(() => {});

    const oldOpen = service.open({ kind: "hosted-shell", bounds: BOUNDS });
    service.closeAll();
    const newOpen = service.open({ kind: "hosted-shell", bounds: BOUNDS });

    expect(handoff).toHaveBeenCalledTimes(1);
    handoffResolvers[0]?.({ ok: true });
    await expect(oldOpen).resolves.toEqual(expect.objectContaining({ state: "failed" }));
    expect(open).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(2));
    handoffResolvers[1]?.({ ok: true });
    await expect(newOpen).resolves.toEqual(expect.objectContaining({ state: "loading" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not attach a stale hosted-shell auth retry after runtime reset", async () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      pendingHostedShells: Map<string, Bounds>;
      performHostedShellHandoff: (gatewayOrigin: string) => Promise<HandoffResult>;
      scheduleHostedShellSessionRefresh: (gatewayOrigin: string) => void;
      manager: {
        open: (
          kind: string,
          slug: string | null,
          bounds: Bounds,
          url: string,
          options: { id?: string },
        ) => string;
      };
    };
    const handoffResolvers: Array<(result: HandoffResult) => void> = [];
    const handoff = vi
      .spyOn(internals, "performHostedShellHandoff")
      .mockImplementation(
        () => new Promise((resolve) => { handoffResolvers.push(resolve); }),
      );
    const open = vi
      .spyOn(internals.manager, "open")
      .mockImplementation((_kind, _slug, _bounds, _url, options) => options.id ?? "missing");
    vi.spyOn(internals, "scheduleHostedShellSessionRefresh").mockImplementation(() => {});

    internals.pendingHostedShells.set("old-shell", BOUNDS);
    const oldRetry = service.retryAuth("old-shell");
    service.closeAll();
    internals.pendingHostedShells.set("new-shell", BOUNDS);
    const newRetry = service.retryAuth("new-shell");

    expect(handoff).toHaveBeenCalledTimes(1);
    handoffResolvers[0]?.({ ok: true });
    await expect(oldRetry).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(2));
    handoffResolvers[1]?.({ ok: true });
    await expect(newRetry).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith(
      "hosted-shell",
      null,
      BOUNDS,
      "https://gateway.test/",
      expect.objectContaining({ id: "new-shell" }),
    );
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

  it("suspends live and pending embeds through the trusted core", () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      pendingHostedShells: Map<string, Bounds>;
      pendingApps: Map<string, { slug: string; appIdentity: string; bounds: Bounds }>;
      pendingActive: Map<string, boolean>;
      manager: { suspendAll: () => boolean };
    };
    const suspendAll = vi.spyOn(internals.manager, "suspendAll").mockReturnValue(true);
    internals.pendingHostedShells.set("embed-shell", BOUNDS);
    internals.pendingApps.set("embed-app", { slug: "notes", appIdentity: "notes", bounds: BOUNDS });
    internals.pendingActive.set("embed-shell", true);
    internals.pendingActive.set("embed-app", true);

    expect(service.suspendAll()).toBe(true);
    expect(suspendAll).toHaveBeenCalledOnce();
    expect(internals.pendingActive.get("embed-shell")).toBe(false);
    expect(internals.pendingActive.get("embed-app")).toBe(false);
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
      pendingApps: Map<string, { slug: string; appIdentity: string; bounds: Bounds }>;
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
        launchUrl: "/apps/2048/",
        expiresAt: Date.now() + 60_000,
      });

    internals.pendingApps.set("embed-app", {
      slug: "2048",
      appIdentity: "games/2048",
      bounds: BOUNDS,
    });

    await expect(service.retryAuth("embed-app")).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(emitState).toHaveBeenCalledWith("embed-app", "auth-required");

    await expect(service.retryAuth("embed-app")).resolves.toBe(true);
    expect(fetchLaunchToken).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(
      "app",
      "games/2048",
      BOUNDS,
      "https://gateway.test/apps/2048/",
      expect.objectContaining({ id: "embed-app", routeSlug: "2048" }),
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
      pendingApps: Map<string, { slug: string; appIdentity: string; bounds: Bounds }>;
      fetchLaunchToken: (gatewayOrigin: string, slug: string) => Promise<{ launchUrl: string; expiresAt: number } | null>;
      manager: { open: (kind: string, slug: string | null, bounds: Bounds, url: string, options: unknown) => string };
    };
    const open = vi.spyOn(internals.manager, "open").mockReturnValue("embed-app");
    let resolveToken!: (token: { launchUrl: string; expiresAt: number }) => void;
    vi.spyOn(internals, "fetchLaunchToken").mockImplementation(
      () => new Promise((resolve) => { resolveToken = resolve; }),
    );

    internals.pendingApps.set("embed-app", { slug: "notes", appIdentity: "notes", bounds: BOUNDS });
    const retry = service.retryAuth("embed-app");
    expect(service.close("embed-app")).toBe(true);
    resolveToken({ launchUrl: "/apps/notes/", expiresAt: Date.now() + 60_000 });

    await expect(retry).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(emitState).not.toHaveBeenCalledWith("embed-app", "loading");
  });
});
