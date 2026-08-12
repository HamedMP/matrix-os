import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import {
  FILE_DIRECTORY_STALE_TTL_MS,
  FileDirectorySubscriptionHub,
} from "../../packages/gateway/src/file-management/directory-subscriptions.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import * as fileDirectoryWs from "../../packages/gateway/src/server/file-directory-ws.js";
import {
  bindFileDirectoryWatcher,
  closeFileDirectoryResources,
  createFileDirectoryWsConnection,
  createMainWsFileDirectoryRouter,
  isFileDirectoryFrameCandidate,
} from "../../packages/gateway/src/server/file-directory-ws.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("main websocket file-directory behavior", () => {
  it("keeps a legacy static-token websocket usable without granting file subscriptions", async () => {
    vi.stubEnv("MATRIX_AUTH_TOKEN", "legacy-static-token");
    vi.stubEnv("MATRIX_USER_ID", "");
    const hub = new FileDirectorySubscriptionHub({ acquireScope: async () => () => {} });
    const send = vi.fn();
    const app = new Hono();
    app.use("*", authMiddleware("legacy-static-token"));
    app.get("/ws", async (c) => {
      const router = createMainWsFileDirectoryRouter(c, {
        connectionId: "connection",
        hub,
        send,
        closeSocket: vi.fn(),
      });
      router.handleFrame({ type: "files:subscribe", directory: "projects" });
      router.rejectInvalidFrame();
      await router.close();
      return c.json({ subscriberCount: hub.subscriberCount });
    });

    const response = await app.request("/ws?token=legacy-static-token");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ subscriberCount: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { type: "kernel:error", message: "File directory subscription failed" },
      { type: "kernel:error", message: "File directory subscription failed" },
    ]);
    await hub.close();
  });

  it("derives the websocket owner from real JWT middleware and removes it on close", async () => {
    const createAuthenticatedConnection = Reflect.get(
      fileDirectoryWs,
      "createAuthenticatedFileDirectoryWsConnection",
    );
    expect(createAuthenticatedConnection).toBeTypeOf("function");
    if (typeof createAuthenticatedConnection !== "function") return;

    const jwtSecret = "file-directory-ws-test-secret-32-chars";
    vi.stubEnv("PLATFORM_JWT_SECRET", jwtSecret);
    vi.stubEnv("MATRIX_HANDLE", "alice");
    vi.stubEnv("MATRIX_RUNTIME_SLOT", "primary");
    const issued = await issueSyncJwt({
      secret: jwtSecret,
      clerkUserId: "canonical-owner",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com/vm/alice",
      runtimeSlot: "primary",
    });
    const authorize = vi.fn(async ({ ownerId }: { ownerId: string }) => ownerId === "canonical-owner");
    const hub = new FileDirectorySubscriptionHub({
      authorize,
      acquireScope: async () => () => {},
    });
    const removeConnection = vi.spyOn(hub, "removeConnection");
    const sent: string[] = [];
    let routeCalls = 0;
    const app = new Hono();
    app.use("*", authMiddleware("legacy-shared-secret"));
    app.get("/ws", async (c) => {
      routeCalls += 1;
      const connection = createAuthenticatedConnection(c, {
        connectionId: "server-connection",
        hub,
        send: (message: string) => { sent.push(message); },
        closeSocket: vi.fn(),
      });
      connection.enqueue({ type: "files:subscribe", directory: "projects" });
      await connection.idle();
      await connection.close();
      return c.json({ ok: true });
    });

    const unauthenticated = await app.request("/ws?ownerId=forged-owner");
    expect(unauthenticated.status).toBe(401);
    expect(routeCalls).toBe(0);

    const authenticated = await app.request(
      `/ws?token=${encodeURIComponent(issued.token)}&ownerId=forged-owner`,
    );
    expect(authenticated.status).toBe(200);
    expect(routeCalls).toBe(1);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: "canonical-owner",
    }));
    expect(authorize).not.toHaveBeenCalledWith(expect.objectContaining({ ownerId: "forged-owner" }));
    expect(removeConnection).toHaveBeenCalledWith("canonical-owner", "server-connection");
    expect(sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "files:subscribed",
      directory: "projects",
      revision: 0,
    });
    await hub.close();
  });

  it("binds subscriptions to the canonical principal and awaits authorization before ack", async () => {
    const authorization = deferred<boolean>();
    const send = vi.fn();
    const hub = new FileDirectorySubscriptionHub({
      authorize: vi.fn(async ({ ownerId }) => {
        expect(ownerId).toBe("canonical-owner");
        return authorization.promise;
      }),
      acquireScope: async () => () => {},
    });
    const connection = createFileDirectoryWsConnection({
      ownerId: "canonical-owner",
      connectionId: "connection-a",
      hub,
      send,
      closeSocket: vi.fn(),
    });

    expect(connection.enqueue({ type: "files:subscribe", directory: "projects" })).toBe(true);
    await flushAsyncWork();
    expect(send).not.toHaveBeenCalled();
    authorization.resolve(true);
    await connection.idle();
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "files:subscribed",
      directory: "projects",
      revision: 0,
    }));
    await connection.close();
    await hub.close();
  });

  it("serializes subscribe, touch, and unsubscribe in arrival order", async () => {
    const operations: string[] = [];
    const hub = new FileDirectorySubscriptionHub({
      authorize: async () => {
        operations.push("authorize");
        return true;
      },
      acquireScope: async () => {
        operations.push("acquire");
        return async () => { operations.push("release"); };
      },
    });
    const connection = createFileDirectoryWsConnection({
      ownerId: "owner",
      connectionId: "connection",
      hub,
      send: vi.fn(() => { operations.push("ack"); }),
      closeSocket: vi.fn(),
    });

    connection.enqueue({ type: "files:subscribe", directory: "projects" });
    connection.enqueue({ type: "files:touch", directory: "projects" });
    connection.enqueue({ type: "files:unsubscribe", directory: "projects" });
    await connection.idle();
    expect(operations).toEqual(["authorize", "acquire", "ack", "release"]);
    expect(hub.subscriberCount).toBe(0);
    await connection.close();
    await hub.close();
  });

  it("closes generically on authorization errors without leaking raw paths", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn();
    const closeSocket = vi.fn();
    const hub = new FileDirectorySubscriptionHub({
      authorize: async () => { throw new Error("EACCES /home/private/projects"); },
      acquireScope: async () => () => {},
    });
    const connection = createFileDirectoryWsConnection({
      ownerId: "owner",
      connectionId: "connection",
      hub,
      send,
      closeSocket,
    });

    connection.enqueue({ type: "files:subscribe", directory: "projects" });
    await connection.idle();
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "kernel:error",
      message: "File directory subscription failed",
    }));
    expect(JSON.stringify(send.mock.calls)).not.toContain("/home/private");
    expect(closeSocket).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalled();
    await connection.close();
    await hub.close();
  });

  it("closes generically for invalid file frames", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn();
    const closeSocket = vi.fn();
    const hub = new FileDirectorySubscriptionHub({ acquireScope: async () => () => {} });
    const connection = createFileDirectoryWsConnection({
      ownerId: "owner",
      connectionId: "connection",
      hub,
      send,
      closeSocket,
    });

    connection.rejectInvalidFrame();
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "kernel:error",
      message: "File directory subscription failed",
    }));
    expect(closeSocket).toHaveBeenCalledOnce();
    expect(connection.enqueue({ type: "files:subscribe", directory: "projects" })).toBe(false);
    await connection.close();
    await hub.close();
    consoleSpy.mockRestore();
  });

  it("resets the acknowledged revision on a new websocket connection", async () => {
    const hub = new FileDirectorySubscriptionHub({ acquireScope: async () => () => {} });
    const firstSend = vi.fn();
    const first = createFileDirectoryWsConnection({
      ownerId: "owner",
      connectionId: "connection-a",
      hub,
      send: firstSend,
      closeSocket: vi.fn(),
    });
    first.enqueue({ type: "files:subscribe", directory: "projects" });
    await first.idle();
    await hub.broadcast({ type: "file:change", path: "projects/readme.md", event: "change" });
    await first.close();

    const secondSend = vi.fn();
    const second = createFileDirectoryWsConnection({
      ownerId: "owner",
      connectionId: "connection-b",
      hub,
      send: secondSend,
      closeSocket: vi.fn(),
    });
    second.enqueue({ type: "files:subscribe", directory: "projects" });
    await second.idle();
    expect(JSON.parse(secondSend.mock.calls[0][0])).toEqual({
      type: "files:subscribed",
      directory: "projects",
      revision: 0,
    });
    await second.close();
    await hub.close();
  });

  it("bounds pending async frames and cleans up on socket close", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const authorization = deferred<boolean>();
    const send = vi.fn();
    const closeSocket = vi.fn();
    const release = vi.fn();
    const hub = new FileDirectorySubscriptionHub({
      authorize: async () => authorization.promise,
      acquireScope: async () => release,
    });
    const connection = createFileDirectoryWsConnection({
      ownerId: "owner",
      connectionId: "connection",
      hub,
      send,
      closeSocket,
      maxPendingFrames: 2,
    });

    expect(connection.enqueue({ type: "files:subscribe", directory: "projects" })).toBe(true);
    await flushAsyncWork();
    expect(connection.enqueue({ type: "files:touch", directory: "projects" })).toBe(true);
    expect(connection.enqueue({ type: "files:touch", directory: "projects" })).toBe(false);
    expect(closeSocket).toHaveBeenCalledOnce();
    authorization.resolve(true);
    await connection.close();
    expect(hub.subscriberCount).toBe(0);
    expect(release).not.toHaveBeenCalled();
  });

  it("cancels pending authorization synchronously when socket close begins", async () => {
    const authorization = deferred<boolean>();
    const acquireScope = vi.fn(async () => vi.fn());
    const hub = new FileDirectorySubscriptionHub({
      authorize: async () => authorization.promise,
      acquireScope,
    });
    const removeConnection = vi.spyOn(hub, "removeConnection");
    const connection = createFileDirectoryWsConnection({
      ownerId: "owner",
      connectionId: "connection",
      hub,
      send: vi.fn(),
      closeSocket: vi.fn(),
    });
    connection.enqueue({ type: "files:subscribe", directory: "projects" });
    await flushAsyncWork();

    const closePromise = connection.close();
    expect(removeConnection).toHaveBeenCalledOnce();
    expect(hub.touch("owner", "connection", "projects")).toBe(false);
    expect(hub.subscriberCount).toBe(1);
    authorization.resolve(true);
    await closePromise;
    expect(acquireScope).not.toHaveBeenCalled();
    expect(hub.subscriberCount).toBe(0);
    await hub.close();
  });

  it("releases an acquisition that commits after socket close begins", async () => {
    const acquisition = deferred<() => void>();
    const release = vi.fn();
    const hub = new FileDirectorySubscriptionHub({
      acquireScope: async () => acquisition.promise,
    });
    const connection = createFileDirectoryWsConnection({
      ownerId: "owner",
      connectionId: "connection",
      hub,
      send: vi.fn(),
      closeSocket: vi.fn(),
    });
    connection.enqueue({ type: "files:subscribe", directory: "projects" });
    await flushAsyncWork();

    const closePromise = connection.close();
    expect(hub.touch("owner", "connection", "projects")).toBe(false);
    acquisition.resolve(release);
    await closePromise;
    expect(release).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(0);
    await hub.close();
  });

  it("cleans a subscription reserved after close waits on a stale sweep", async () => {
    let now = 0;
    const staleReleaseGate = deferred<void>();
    const staleRelease = vi.fn(async () => staleReleaseGate.promise);
    const lateRelease = vi.fn();
    const acquireScope = vi.fn()
      .mockResolvedValueOnce(staleRelease)
      .mockResolvedValueOnce(lateRelease);
    const hub = new FileDirectorySubscriptionHub({
      maxSubscriptions: 1,
      now: () => now,
      acquireScope,
    });
    await hub.subscribe({
      ownerId: "stale-owner",
      connectionId: "stale-connection",
      directory: "projects",
      send: vi.fn(),
    });
    now = FILE_DIRECTORY_STALE_TTL_MS;
    const connection = createFileDirectoryWsConnection({
      ownerId: "owner",
      connectionId: "connection",
      hub,
      send: vi.fn(),
      closeSocket: vi.fn(),
    });
    connection.enqueue({ type: "files:subscribe", directory: "projects" });
    await vi.waitFor(() => expect(staleRelease).toHaveBeenCalledOnce());

    const closePromise = connection.close();
    staleReleaseGate.resolve();
    await closePromise;
    expect(acquireScope).toHaveBeenCalledTimes(2);
    expect(lateRelease).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(0);
    await hub.close();
  });

  it("detects only files-prefixed malformed frames for generic-close handling", () => {
    expect(isFileDirectoryFrameCandidate({ type: "files:subscribe", directory: "/bad" })).toBe(true);
    expect(isFileDirectoryFrameCandidate({ type: "ping", extra: true })).toBe(false);
    expect(isFileDirectoryFrameCandidate(null)).toBe(false);
  });

  it("exposes the onClose lifecycle callback used by the websocket route", async () => {
    const createLifecycle = Reflect.get(fileDirectoryWs, "createFileDirectoryWsLifecycle");
    expect(createLifecycle).toBeTypeOf("function");
    if (typeof createLifecycle !== "function") return;
    const closeGate = deferred<void>();
    const close = vi.fn(async () => closeGate.promise);
    const lifecycle = createLifecycle({ close });

    const closeResult = lifecycle.onClose();
    expect(close).toHaveBeenCalledOnce();
    closeGate.resolve();
    await closeResult;
  });

  it("binds one watcher listener and shuts the hub down before the shared watcher", async () => {
    const order: string[] = [];
    const listeners: Array<(event: { type: "file:change"; path: string; event: "add" }) => void> = [];
    const watcher = {
      on: vi.fn((listener) => { listeners.push(listener); }),
      acquireDirectoryScope: vi.fn(async () => () => {}),
      close: vi.fn(async () => { order.push("watcher"); }),
    };
    const hub = new FileDirectorySubscriptionHub({
      acquireScope: (directory) => watcher.acquireDirectoryScope(directory),
    });
    const hubClose = vi.spyOn(hub, "close").mockImplementation(async () => { order.push("hub"); });

    bindFileDirectoryWatcher(hub, watcher);
    expect(watcher.on).toHaveBeenCalledOnce();
    expect(listeners).toHaveLength(1);
    await closeFileDirectoryResources(hub, watcher);
    expect(order).toEqual(["hub", "watcher"]);
    expect(hubClose).toHaveBeenCalledOnce();
  });
});
