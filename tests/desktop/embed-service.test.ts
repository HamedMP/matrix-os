import { EventEmitter } from "node:events";
import { net } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedService } from "@desktop/main/embeds/embed-service";
import type { Bounds } from "@desktop/main/embeds/embed-manager";
import type { HandoffResult } from "@desktop/main/embeds/app-session";
import type { PortForwardHandle } from "@finnaai/matrix/port-forward";

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

  it("opens VS Code only at the fixed authenticated Matrix code origin", async () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      runCodeEditorHandoff: (gatewayOrigin: string) => Promise<HandoffResult>;
      manager: {
        open: (
          kind: string,
          slug: string | null,
          bounds: Bounds,
          url: string,
          options: unknown,
        ) => string;
      };
    };
    vi.spyOn(internals, "runCodeEditorHandoff").mockResolvedValue({ ok: true });
    const open = vi.spyOn(internals.manager, "open").mockImplementation((...args) => (
      (args[4] as { id: string }).id
    ));

    const result = await service.open({ kind: "code-editor", bounds: BOUNDS });

    expect(open).toHaveBeenCalledWith(
      "code-editor",
      null,
      BOUNDS,
      "https://code.matrix-os.com/",
      expect.objectContaining({
        id: result.embedId,
        allowedOrigins: ["https://code.matrix-os.com"],
      }),
    );
  });

  it("does not attach a stale VS Code handoff after a runtime reset", async () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      runCodeEditorHandoff: (gatewayOrigin: string) => Promise<HandoffResult>;
      manager: { open: (...args: unknown[]) => string };
    };
    let resolveHandoff!: (result: HandoffResult) => void;
    vi.spyOn(internals, "runCodeEditorHandoff").mockImplementation(
      () => new Promise((resolve) => { resolveHandoff = resolve; }),
    );
    const open = vi.spyOn(internals.manager, "open").mockReturnValue("code-1");

    const opening = service.open({ kind: "code-editor", bounds: BOUNDS });
    service.closeAll();
    resolveHandoff({ ok: true });

    await expect(opening).resolves.toMatchObject({ state: "failed" });
    expect(open).not.toHaveBeenCalled();
  });

  it("caps pending VS Code handoffs", async () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      runCodeEditorHandoff: (gatewayOrigin: string) => Promise<HandoffResult>;
    };
    vi.spyOn(internals, "runCodeEditorHandoff").mockImplementation(
      () => new Promise(() => {}),
    );

    const openings = Array.from({ length: 13 }, () => (
      service.open({ kind: "code-editor", bounds: BOUNDS })
    ));

    await expect(openings.at(-1)).resolves.toMatchObject({ state: "failed" });
    expect(internals.runCodeEditorHandoff).toHaveBeenCalledTimes(12);
    service.closeAll();
  });

  it("opens public websites directly without starting a runtime tunnel", async () => {
    const startPortForward = vi.fn();
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
      startPortForward,
    });
    const internals = service as unknown as {
      manager: { open: (...args: unknown[]) => string };
    };
    const open = vi.spyOn(internals.manager, "open").mockImplementation((...args) => (
      (args[4] as { id: string }).id
    ));

    const result = await service.open({
      kind: "browser",
      url: "https://matrix-os.com/docs",
      bounds: BOUNDS,
    });

    expect(result.state).toBe("loading");
    expect(startPortForward).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      "browser",
      null,
      BOUNDS,
      "https://matrix-os.com/docs",
      expect.objectContaining({
        id: result.embedId,
        allowedOrigins: ["https://matrix-os.com"],
        allowPublicNavigation: true,
      }),
    );
  });

  it("tunnels runtime loopback pages through Matrix and closes the tunnel with the embed", async () => {
    const closeForward = vi.fn(async () => {});
    const startPortForward = vi.fn(async () => ({
      localHost: "127.0.0.1" as const,
      localPort: 49152,
      remoteHost: "127.0.0.1" as const,
      remotePort: 3000,
      ready: Promise.resolve(),
      closed: new Promise<void>(() => {}),
      close: closeForward,
    }));
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
      startPortForward,
    });
    const internals = service as unknown as {
      manager: {
        open: (
          kind: string,
          slug: string | null,
          bounds: Bounds,
          url: string,
          options: unknown,
        ) => string;
      };
    };
    let browserOptions!: {
      id: string;
      resolveNavigation: (url: string) => unknown;
    };
    const open = vi.spyOn(internals.manager, "open").mockImplementation((_kind, _slug, _bounds, _url, options) => {
      expect(options).toEqual(expect.objectContaining({ id: expect.any(String) }));
      browserOptions = options as typeof browserOptions;
      return browserOptions.id;
    });

    const result = await service.open({
      kind: "browser",
      url: "http://127.0.0.1:3000/docs?q=matrix#api",
      bounds: BOUNDS,
    });

    expect(startPortForward).toHaveBeenCalledWith(expect.objectContaining({
      gatewayUrl: "https://gateway.test",
      token: "token",
      localHost: "127.0.0.1",
      localPort: 0,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
    }));
    expect(open).toHaveBeenCalledWith(
      "browser",
      null,
      BOUNDS,
      "http://127.0.0.1:49152/docs?q=matrix#api",
      expect.objectContaining({
        id: result.embedId,
        allowedOrigins: ["http://127.0.0.1:49152"],
        resolveNavigation: expect.any(Function),
      }),
    );
    expect(browserOptions.resolveNavigation("http://localhost:3000/canonical?q=1")).toEqual({
      disposition: "rewrite",
      url: "http://127.0.0.1:49152/canonical?q=1",
    });
    expect(browserOptions.resolveNavigation("http://localhost:4000/other")).toEqual({
      disposition: "block",
    });

    expect(service.close(result.embedId)).toBe(true);
    await vi.waitFor(() => expect(closeForward).toHaveBeenCalledTimes(1));
  });

  it("cleans up a pending Browser tunnel when its embed closes before forwarding is ready", async () => {
    let resolveForward!: (value: PortForwardHandle) => void;
    const closeForward = vi.fn(async () => {});
    const startPortForward = vi.fn(() => new Promise<PortForwardHandle>((resolve) => {
      resolveForward = resolve;
    }));
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
      startPortForward,
    });

    const opening = service.open({ kind: "browser", url: "127.0.0.1:3000", bounds: BOUNDS });
    await vi.waitFor(() => expect(startPortForward).toHaveBeenCalledOnce());
    const pendingId = Array.from((service as unknown as { pendingBrowsers: Set<string> }).pendingBrowsers)[0]!;
    expect(service.close(pendingId)).toBe(true);
    resolveForward({
      localHost: "127.0.0.1",
      localPort: 49152,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
      ready: Promise.resolve(),
      closed: new Promise<void>(() => {}),
      close: closeForward,
    });

    await expect(opening).resolves.toMatchObject({ embedId: pendingId, state: "failed" });
    await vi.waitFor(() => expect(closeForward).toHaveBeenCalledOnce());
  });

  it("keeps a pending Browser tunnel inactive when it finishes opening in the background", async () => {
    let resolveForward!: (value: PortForwardHandle) => void;
    const startPortForward = vi.fn(() => new Promise<PortForwardHandle>((resolve) => {
      resolveForward = resolve;
    }));
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
      startPortForward,
    });
    const internals = service as unknown as {
      pendingBrowsers: Set<string>;
      manager: { open: (...args: unknown[]) => string };
    };
    const open = vi.spyOn(internals.manager, "open").mockImplementation((...args) => (
      (args[4] as { id: string }).id
    ));

    const opening = service.open({ kind: "browser", url: "127.0.0.1:3000", bounds: BOUNDS });
    await vi.waitFor(() => expect(startPortForward).toHaveBeenCalledOnce());
    const pendingId = Array.from(internals.pendingBrowsers)[0]!;
    expect(service.setActive(pendingId, false)).toBe(true);
    resolveForward({
      localHost: "127.0.0.1",
      localPort: 49152,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
      ready: Promise.resolve(),
      closed: new Promise<void>(() => {}),
      close: vi.fn(async () => {}),
    });

    await expect(opening).resolves.toMatchObject({ embedId: pendingId, state: "loading" });
    expect(open).toHaveBeenCalledWith(
      "browser",
      null,
      BOUNDS,
      "http://127.0.0.1:49152/",
      expect.objectContaining({ id: pendingId, active: false }),
    );
  });

  it("caps pending Browser tunnels", async () => {
    const startPortForward = vi.fn(() => new Promise<PortForwardHandle>(() => {}));
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
      startPortForward,
    });

    const openings = Array.from({ length: 13 }, (_, index) => service.open({
      kind: "browser" as const,
      url: `127.0.0.1:${3000 + index}`,
      bounds: BOUNDS,
    }));

    await expect(openings.at(-1)).resolves.toMatchObject({ state: "failed" });
    expect(startPortForward).toHaveBeenCalledTimes(12);
    service.closeAll();
  });

  it("invalidates a pending Browser tunnel when the selected runtime changes", async () => {
    let resolveForward!: (value: PortForwardHandle) => void;
    const closeForward = vi.fn(async () => {});
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
      startPortForward: () => new Promise<PortForwardHandle>((resolve) => {
        resolveForward = resolve;
      }),
    });
    const opening = service.open({ kind: "browser", url: "127.0.0.1:3000", bounds: BOUNDS });
    await vi.waitFor(() => expect(
      (service as unknown as { pendingBrowsers: Set<string> }).pendingBrowsers.size,
    ).toBe(1));

    service.closeAll();
    resolveForward({
      localHost: "127.0.0.1",
      localPort: 49152,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
      ready: Promise.resolve(),
      closed: new Promise<void>(() => {}),
      close: closeForward,
    });

    await expect(opening).resolves.toMatchObject({ state: "failed" });
    await vi.waitFor(() => expect(closeForward).toHaveBeenCalledOnce());
  });

  it("evicts the Browser embed when tunnel termination rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejectClosed!: (error: Error) => void;
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState: vi.fn(),
      startPortForward: async () => ({
        localHost: "127.0.0.1",
        localPort: 49152,
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        ready: Promise.resolve(),
        closed: new Promise<void>((_resolve, reject) => { rejectClosed = reject; }),
        close: vi.fn(async () => {}),
      }),
    });
    const internals = service as unknown as {
      browserForwards: Map<string, PortForwardHandle>;
      manager: {
        open: (...args: unknown[]) => string;
        close: (embedId: string) => boolean;
      };
    };
    vi.spyOn(internals.manager, "open").mockImplementation((...args) => (
      (args[4] as { id: string }).id
    ));
    const closeEmbed = vi.spyOn(internals.manager, "close").mockReturnValue(true);

    const result = await service.open({ kind: "browser", url: "127.0.0.1:3000", bounds: BOUNDS });
    rejectClosed(new Error("forward failed"));

    await vi.waitFor(() => expect(closeEmbed).toHaveBeenCalledWith(result.embedId));
    expect(internals.browserForwards.has(result.embedId)).toBe(false);
  });

  it("reports a recoverable failure when an established Browser tunnel closes normally", async () => {
    let resolveClosed!: () => void;
    const emitState = vi.fn();
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "token",
      emitState,
      startPortForward: async () => ({
        localHost: "127.0.0.1",
        localPort: 49152,
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        ready: Promise.resolve(),
        closed: new Promise<void>((resolve) => { resolveClosed = resolve; }),
        close: vi.fn(async () => {}),
      }),
    });
    const internals = service as unknown as {
      manager: {
        open: (...args: unknown[]) => string;
        close: (embedId: string) => boolean;
      };
    };
    vi.spyOn(internals.manager, "open").mockImplementation((...args) => (
      (args[4] as { id: string }).id
    ));
    const closeEmbed = vi.spyOn(internals.manager, "close").mockReturnValue(true);
    const result = await service.open({ kind: "browser", url: "127.0.0.1:3000", bounds: BOUNDS });

    resolveClosed();

    await vi.waitFor(() => expect(emitState).toHaveBeenCalledWith(result.embedId, "failed"));
    expect(closeEmbed).toHaveBeenCalledWith(result.embedId);
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
      pendingBrowsers: Set<string>;
      pendingActive: Map<string, boolean>;
      manager: { suspendAll: () => boolean };
    };
    const suspendAll = vi.spyOn(internals.manager, "suspendAll").mockReturnValue(true);
    internals.pendingHostedShells.set("embed-shell", BOUNDS);
    internals.pendingApps.set("embed-app", { slug: "notes", appIdentity: "notes", bounds: BOUNDS });
    internals.pendingBrowsers.add("embed-browser");
    internals.pendingActive.set("embed-shell", true);
    internals.pendingActive.set("embed-app", true);
    internals.pendingActive.set("embed-browser", true);

    expect(service.suspendAll()).toBe(true);
    expect(suspendAll).toHaveBeenCalledOnce();
    expect(internals.pendingActive.get("embed-shell")).toBe(false);
    expect(internals.pendingActive.get("embed-app")).toBe(false);
    expect(internals.pendingActive.get("embed-browser")).toBe(false);
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
