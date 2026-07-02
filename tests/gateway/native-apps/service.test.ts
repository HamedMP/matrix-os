import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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
  const service = new NativeAppSessionService({
    registry: createDefaultNativeAppRegistry(),
    commandExists: vi.fn(async (command) => command === "xpra"),
    getuid: () => 1000,
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
      streamUrl: "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/",
    });
    expect(launched).toHaveLength(1);
    expect(launched[0].command).toBe("xpra");
    expect(launched[0].args).toEqual(expect.arrayContaining([
      "start",
      ":100",
      "--start-child=xterm",
      "--exit-with-children",
      "--bind-tcp=127.0.0.1:46000",
      "--html=on",
      "--daemon=no",
    ]));
    expect(launched[0].args.join(" ")).not.toContain("rm -rf");
  });

  it("enforces max sessions per owner", async () => {
    const { service } = createService({ maxSessionsPerOwner: 1 });

    await service.launchSession({ ownerId: "alice", appId: "xterm" });
    await expect(service.launchSession({ ownerId: "alice", appId: "xterm" }))
      .rejects.toMatchObject({ code: "session_limit" });
  });

  it("prevents users from inspecting or terminating another user's session", async () => {
    const { service } = createService();
    const session = await service.launchSession({ ownerId: "alice", appId: "xterm" });

    expect(service.inspectSession("bob", session.id)).toBeNull();
    await expect(service.terminateSession("bob", session.id)).rejects.toMatchObject({ code: "not_found" });
    expect(service.inspectSession("alice", session.id)?.status).toBe("running");
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

  it("refuses to launch native apps from a root gateway process", async () => {
    const { service } = createService({ getuid: () => 0 });

    await expect(service.launchSession({ ownerId: "alice", appId: "xterm" }))
      .rejects.toMatchObject({ code: "misconfigured" });
  });
});
