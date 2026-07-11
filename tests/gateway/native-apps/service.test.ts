import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PortPool } from "../../../packages/gateway/src/app-runtime/port-pool.js";
import {
  NativeAppSessionService,
  createDefaultNativeAppRegistry,
  type NativeAppChildProcess,
} from "../../../packages/gateway/src/native-apps/index.js";

function createChild(pid = 4321): NativeAppChildProcess & EventEmitter {
  const child = new EventEmitter() as NativeAppChildProcess & EventEmitter;
  child.pid = pid;
  child.stderr = new EventEmitter() as NativeAppChildProcess["stderr"];
  child.kill = vi.fn(() => true);
  return child;
}

function createService(options: Partial<ConstructorParameters<typeof NativeAppSessionService>[0]> = {}) {
  const launched: Array<{ command: string; args: string[] }> = [];
  const children: Array<NativeAppChildProcess & EventEmitter> = [];
  const missingProcessGroup = vi.fn(() => {
    throw Object.assign(new Error("process group not found"), { code: "ESRCH" });
  });
  const service = new NativeAppSessionService({
    registry: createDefaultNativeAppRegistry(),
    commandExists: vi.fn(async (command) => command === "xpra"),
    getuid: () => 1000,
    killProcess: missingProcessGroup,
    randomId: vi.fn()
      .mockReturnValueOnce("session_aaaaaaaaaaaaaaaaaaaaaaaa")
      .mockReturnValueOnce("stream_bbbbbbbbbbbbbbbbbbbbbbbb")
      .mockReturnValueOnce("session_cccccccccccccccccccccccc")
      .mockReturnValueOnce("stream_dddddddddddddddddddddddd")
      .mockReturnValueOnce("session_eeeeeeeeeeeeeeeeeeeeeeee")
      .mockReturnValueOnce("stream_ffffffffffffffffffffffff")
      .mockReturnValueOnce("session_gggggggggggggggggggggggg")
      .mockReturnValueOnce("stream_hhhhhhhhhhhhhhhhhhhhhhhh"),
    reaperIntervalMs: 0,
    readinessProbe: vi.fn(async () => true),
    readinessRetryMs: 1,
    readinessTimeoutMs: 20,
    stopGraceMs: 1,
    spawn: (command, args) => {
      launched.push({ command, args });
      const child = createChild(4000 + children.length);
      children.push(child);
      return child;
    },
    ...options,
  });
  return { service, launched, children };
}

describe("NativeAppSessionService", () => {
  it("returns only curated enabled linux-native apps", () => {
    const { service } = createService();

    expect(service.listApps()).toEqual([
      expect.objectContaining({
        id: "xterm",
        name: "Xterm",
        runtime: "linux-native",
        command: ["xterm"],
        enabled: true,
        permissions: { filesystem: "none", network: false, clipboard: false },
      }),
      expect.objectContaining({
        id: "xcalc",
        name: "XCalc",
        runtime: "linux-native",
        command: ["xcalc"],
        enabled: true,
        permissions: { filesystem: "none", network: false, clipboard: false },
      }),
    ]);
  });

  it("rejects invalid app IDs before spawning", async () => {
    const { service, launched } = createService();

    await expect(service.launchSession({ ownerId: "alice", appId: "chrome", width: 1024, height: 768 }))
      .rejects.toMatchObject({ code: "app_unavailable" });
    expect(launched).toEqual([]);
  });

  it("launches only the registry command through xpra argv", async () => {
    const { service, launched } = createService();

    const session = await service.launchSession({ ownerId: "alice", appId: "xterm", width: 1024, height: 768 });

    expect(session).toMatchObject({
      id: "session_aaaaaaaaaaaaaaaaaaaaaaaa",
      ownerId: "alice",
      appId: "xterm",
      status: "running",
      streamUrl: "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/stream_bbbbbbbbbbbbbbbbbbbbbbbb/",
    });
    expect(launched).toHaveLength(1);
    expect(launched[0].command).toBe("xpra");
    expect(launched[0].args).toEqual(expect.arrayContaining([
      "start",
      ":100",
      "--start-child=xterm",
      "--terminate-children=yes",
      "--exit-with-children",
      "--bind=none",
      "--bind-tcp=127.0.0.1:46000",
      "--html=on",
      "--daemon=no",
      "--file-transfer=no",
      "--open-files=no",
    ]));
    expect(launched[0].args.join(" ")).not.toContain("rm -rf");
  });

  it("waits for xpra readiness before returning the session", async () => {
    const readinessProbe = vi.fn(async () => readinessProbe.mock.calls.length >= 2);
    const { service } = createService({ readinessProbe });

    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });

    expect(session.status).toBe("running");
    expect(readinessProbe).toHaveBeenCalledTimes(2);
    expect(readinessProbe).toHaveBeenCalledWith(46000);
  });

  it("terminates and releases a session when xpra never becomes ready", async () => {
    let ready = false;
    const { service, children } = createService({
      readinessProbe: vi.fn(async () => ready),
      readinessTimeoutMs: 1,
    });

    await expect(service.launchSession({ ownerId: "alice", appId: "xterm" }))
      .rejects.toMatchObject({
        code: "spawn_failed",
        clientMessage: "Native apps are not available on this runtime",
      });
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    ready = true;
    await expect(service.launchSession({ ownerId: "alice", appId: "xterm" })).resolves.toMatchObject({
      status: "running",
    });
  });

  it("fails launch promptly when xpra exits before readiness", async () => {
    let spawnedChildren: Array<NativeAppChildProcess & EventEmitter> = [];
    const readinessProbe = vi.fn(async () => {
      spawnedChildren[0]?.emit("exit", 1, null);
      return false;
    });
    const { service, children } = createService({
      readinessProbe,
      readinessRetryMs: 50,
      readinessTimeoutMs: 1_000,
    });
    spawnedChildren = children;

    await expect(service.launchSession({ ownerId: "alice", appId: "xterm" }))
      .rejects.toMatchObject({
        code: "spawn_failed",
        clientMessage: "Native apps are not available on this runtime",
      });
    expect(service.inspectSession("alice", "session_aaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(readinessProbe).toHaveBeenCalledTimes(1);
  });

  it("releases an allocated port when display allocation fails", async () => {
    const portPool = new PortPool({ min: 47000, max: 47000, cap: 1 });
    const displayPool = new PortPool({ min: 100, max: 100, cap: 1 });
    displayPool.allocate();
    const { service } = createService({ portPool, displayPool });

    await expect(service.launchSession({ ownerId: "alice", appId: "xterm" }))
      .rejects.toMatchObject({ clientMessage: "Native apps are not available on this runtime" });

    expect(portPool.inUse()).toEqual([]);
  });

  it("releases process resources once when SIGTERM also emits child exit", async () => {
    const portPool = {
      allocate: vi.fn(() => 47000),
      release: vi.fn(),
      inUse: vi.fn(() => []),
    } as unknown as PortPool;
    const displayPool = {
      allocate: vi.fn(() => 100),
      release: vi.fn(),
      inUse: vi.fn(() => []),
    } as unknown as PortPool;
    const { service, children } = createService({ portPool, displayPool });
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });
    children[0].kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        children[0].emit("exit", 0, signal);
      }
      return true;
    });

    await service.terminateSession("alice", session.id);

    expect(portPool.release).toHaveBeenCalledTimes(1);
    expect(displayPool.release).toHaveBeenCalledTimes(1);
  });

  it("terminates xpra directly before force-killing its detached process group", async () => {
    const killProcess = vi.fn();
    const { service, children } = createService({ killProcess });
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });

    await service.terminateSession("alice", session.id);

    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(killProcess).toHaveBeenCalledWith(-(children[0].pid ?? 0), "SIGKILL");
  });

  it("allows a gracefully exiting xpra server to clean its X server", async () => {
    const killProcess = vi.fn();
    const { service, children } = createService({ killProcess });
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });
    children[0].kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === "SIGTERM") children[0].emit("exit", 0, signal);
      return true;
    });

    await service.terminateSession("alice", session.id);

    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("kills remaining process-group members when the xpra parent exits", async () => {
    const killProcess = vi.fn();
    const { service, children } = createService({ killProcess });
    await service.launchSession({ ownerId: "alice", appId: "xterm" });

    children[0].emit("exit", 1, null);

    expect(killProcess).toHaveBeenCalledWith(-(children[0].pid ?? 0), "SIGKILL");
  });

  it("enforces max sessions per owner", async () => {
    const { service } = createService({ maxSessionsPerOwner: 1 });

    await service.launchSession({ ownerId: "alice", appId: "xterm" });
    await expect(service.launchSession({ ownerId: "alice", appId: "xterm" }))
      .rejects.toMatchObject({ code: "session_limit" });
  });

  it("rechecks owner capacity after asynchronous xpra availability checks", async () => {
    const resolvers: Array<(available: boolean) => void> = [];
    const commandExists = vi.fn(async () => new Promise<boolean>((resolve) => {
      resolvers.push(resolve);
    }));
    const { service, launched } = createService({
      commandExists,
      maxSessionsPerOwner: 1,
    });

    const first = service.launchSession({ ownerId: "alice", appId: "xterm" });
    const second = service.launchSession({ ownerId: "alice", appId: "xterm" });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    for (const resolve of resolvers) resolve(true);

    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "session_limit" }),
        status: "rejected",
      }),
    ]);
    expect(launched).toHaveLength(1);
  });

  it("prevents users from inspecting or terminating another user's session", async () => {
    const { service } = createService();
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });

    expect(service.inspectSession("bob", session.id)).toBeNull();
    await expect(service.terminateSession("bob", session.id)).rejects.toMatchObject({ code: "not_found" });
    expect(service.inspectSession("alice", session.id)?.status).toBe("running");
  });

  it("requires the exact stream token for stream targets", async () => {
    const { service } = createService();
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });
    const token = service.streamCookieValue(session.id);

    expect(service.getStreamTarget(session.id, `${token}x`)).toBeNull();
    expect(service.getStreamTarget(session.id, token ?? "")).toEqual({ port: 46000 });
  });

  it("cleans up stale sessions and releases child processes", async () => {
    let now = 1_000;
    const { service, children } = createService({
      now: () => now,
      sessionTtlMs: 10,
    });
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });

    now = 1_020;
    await service.cleanupExpiredSessions();

    expect(service.inspectSession("alice", session.id)).toBeNull();
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("returns a generic unavailable error when xpra is missing", async () => {
    const { service } = createService({
      commandExists: vi.fn(async () => false),
    });

    await expect(service.launchSession({ ownerId: "alice", appId: "xterm" }))
      .rejects.toMatchObject({
        code: "native_unavailable",
        clientMessage: "Native apps are not available on this runtime",
      });
  });

  it("caches xpra availability checks across launches", async () => {
    const commandExists = vi.fn(async () => true);
    const { service } = createService({ commandExists });

    await service.launchSession({ ownerId: "alice", appId: "xterm" });
    await service.launchSession({ ownerId: "alice", appId: "xterm" });

    expect(commandExists).toHaveBeenCalledTimes(1);
    expect(commandExists).toHaveBeenCalledWith("xpra");
  });

  it("logs bounded xpra stderr when a child process errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service, children } = createService();
    await service.launchSession({ ownerId: "alice", appId: "xterm" });

    (children[0].stderr as EventEmitter).emit("data", Buffer.from("display failed"));
    children[0].emit("error", new Error("spawn exploded"));

    expect(warn).toHaveBeenCalledWith("[native-apps] child error:", "spawn exploded", "stderr:", "display failed");
    warn.mockRestore();
  });

  it("refuses to launch native apps from a root gateway process", async () => {
    const { service } = createService({ getuid: () => 0 });

    await expect(service.launchSession({ ownerId: "alice", appId: "xterm" }))
      .rejects.toMatchObject({ code: "misconfigured" });
  });
});
