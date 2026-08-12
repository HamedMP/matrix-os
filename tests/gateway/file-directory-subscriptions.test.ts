import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeFileDirectory,
  FILE_DIRECTORY_MAX_CONNECTIONS_PER_OWNER,
  FILE_DIRECTORY_MAX_DIRECTORIES_PER_CONNECTION,
  FILE_DIRECTORY_MAX_SUBSCRIPTIONS,
  FILE_DIRECTORY_STALE_TTL_MS,
  FileDirectorySubscriptionHub,
} from "../../packages/gateway/src/file-management/directory-subscriptions.js";

function subscriber(
  ownerId: string,
  connectionId: string,
  directory: string,
  send = vi.fn(),
) {
  return { ownerId, connectionId, directory, send };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FileDirectorySubscriptionHub", () => {
  it("authorizes existing owner directories but rejects protected, denied, file, and symlink scopes", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-directory-auth-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "matrix-directory-outside-"));
    try {
      await mkdir(join(homePath, "projects"));
      await mkdir(join(homePath, "projects", ".secret"));
      await mkdir(join(homePath, "projects", "visible", ".hidden"), { recursive: true });
      await mkdir(join(homePath, "system"));
      await mkdir(join(homePath, "data", "browser-profiles"), { recursive: true });
      await symlink(join(homePath, "data"), join(homePath, "projects", "data-link"));
      await writeFile(join(homePath, "readme.md"), "file");
      await symlink(outsidePath, join(homePath, "escaped"));

      await expect(authorizeFileDirectory(homePath, "")).resolves.toBe(true);
      await expect(authorizeFileDirectory(homePath, "projects")).resolves.toBe(true);
      await expect(authorizeFileDirectory(homePath, ".secret")).resolves.toBe(false);
      await expect(authorizeFileDirectory(homePath, "projects/.secret")).resolves.toBe(false);
      await expect(authorizeFileDirectory(homePath, "projects/visible/.hidden")).resolves.toBe(false);
      await expect(authorizeFileDirectory(homePath, "projects\\.secret")).resolves.toBe(false);
      await expect(authorizeFileDirectory(homePath, "C:/projects")).resolves.toBe(false);
      await expect(authorizeFileDirectory(homePath, "system")).resolves.toBe(false);
      await expect(authorizeFileDirectory(homePath, "data")).resolves.toBe(false);
      await expect(authorizeFileDirectory(homePath, "readme.md")).resolves.toBe(false);
      await expect(authorizeFileDirectory(homePath, "escaped")).resolves.toBe(false);
      await expect(authorizeFileDirectory(homePath, "projects/data-link/browser-profiles")).resolves.toBe(false);
    } finally {
      await rm(homePath, { recursive: true });
      await rm(outsidePath, { recursive: true });
    }
  });

  it("keys touch and unsubscribe by exact owner, connection, and directory", async () => {
    let now = 1;
    const release = vi.fn();
    const hub = new FileDirectorySubscriptionHub({
      now: () => now,
      acquireScope: vi.fn(async () => release),
    });
    await hub.subscribe(subscriber("owner-a", "connection-a", "projects"));

    now = 2;
    expect(hub.touch("owner-b", "connection-a", "projects")).toBe(false);
    expect(await hub.unsubscribe("owner-a", "connection-b", "projects")).toBe(false);
    expect(await hub.unsubscribe("owner-a", "connection-a", "other")).toBe(false);
    expect(hub.subscriberCount).toBe(1);

    expect(hub.touch("owner-a", "connection-a", "projects")).toBe(true);
    expect(await hub.unsubscribe("owner-a", "connection-a", "projects")).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    await hub.close();
  });

  it("enforces the exact default global, per-connection, and per-owner bounds", async () => {
    const globalHub = new FileDirectorySubscriptionHub({ acquireScope: async () => () => {} });
    for (let index = 0; index < FILE_DIRECTORY_MAX_SUBSCRIPTIONS; index += 1) {
      await globalHub.subscribe(subscriber(`owner-${index}`, `connection-${index}`, "projects"));
    }
    await expect(globalHub.subscribe(subscriber("overflow", "overflow", "projects")))
      .rejects.toThrow("subscription limit");
    expect(globalHub.subscriberCount).toBe(1_024);
    await globalHub.close();

    const connectionHub = new FileDirectorySubscriptionHub({ acquireScope: async () => () => {} });
    for (let index = 0; index < FILE_DIRECTORY_MAX_DIRECTORIES_PER_CONNECTION; index += 1) {
      await connectionHub.subscribe(subscriber("owner", "connection", `projects/${index}`));
    }
    await expect(connectionHub.subscribe(subscriber("owner", "connection", "projects/overflow")))
      .rejects.toThrow(/directory limit/i);
    expect(connectionHub.subscriberCount).toBe(8);
    await connectionHub.close();

    const ownerHub = new FileDirectorySubscriptionHub({ acquireScope: async () => () => {} });
    for (let index = 0; index < FILE_DIRECTORY_MAX_CONNECTIONS_PER_OWNER; index += 1) {
      await ownerHub.subscribe(subscriber("owner", `connection-${index}`, "projects"));
    }
    await expect(ownerHub.subscribe(subscriber("owner", "connection-overflow", "projects")))
      .rejects.toThrow(/connection limit/i);
    expect(ownerHub.subscriberCount).toBe(32);
    await ownerHub.close();
  });

  it("sweeps five-minute stale entries before caps and on a closeable timer", async () => {
    vi.useFakeTimers();
    let now = 0;
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const hub = new FileDirectorySubscriptionHub({
      maxSubscriptions: 1,
      now: () => now,
      sweepIntervalMs: 1_000,
      acquireScope: async () => {
        const release = vi.fn();
        releases.push(release);
        return release;
      },
    });
    await hub.subscribe(subscriber("owner-a", "connection-a", "projects"));

    now = FILE_DIRECTORY_STALE_TTL_MS;
    await hub.subscribe(subscriber("owner-b", "connection-b", "projects"));
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(1);

    now += FILE_DIRECTORY_STALE_TTL_MS;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(releases[1]).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    await hub.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains an active stale release and prevents its waiting subscribe after close", async () => {
    let now = 0;
    const releaseGate = deferred<void>();
    const release = vi.fn(async () => releaseGate.promise);
    const acquireScope = vi.fn(async () => release);
    const hub = new FileDirectorySubscriptionHub({
      maxSubscriptions: 1,
      now: () => now,
      acquireScope,
    });
    await hub.subscribe(subscriber("owner-a", "connection-a", "projects"));

    now = FILE_DIRECTORY_STALE_TTL_MS;
    const waitingSubscribe = hub.subscribe(subscriber("owner-b", "connection-b", "projects"));
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    let closeSettled = false;
    const closePromise = hub.close().then(() => { closeSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);

    releaseGate.resolve();
    await closePromise;
    await expect(waitingSubscribe).rejects.toThrow("closed");
    expect(acquireScope).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(0);
  });

  it("keeps releasing scopes inside the global resource budget", async () => {
    const releaseGate = deferred<void>();
    const hub = new FileDirectorySubscriptionHub({
      maxSubscriptions: 1,
      acquireScope: async () => async () => releaseGate.promise,
    });
    await hub.subscribe(subscriber("owner-a", "connection-a", "projects"));

    const unsubscribePromise = hub.unsubscribe("owner-a", "connection-a", "projects");
    await expect(hub.subscribe(subscriber("owner-b", "connection-b", "projects")))
      .rejects.toThrow("subscription limit");
    releaseGate.resolve();
    await unsubscribePromise;
    await expect(hub.subscribe(subscriber("owner-b", "connection-b", "projects")))
      .resolves.toBe(0);
    await hub.close();
  });

  it("memoizes exact cleanup across repeated unsubscribe and cap rejection", async () => {
    const releaseGate = deferred<void>();
    const release = vi.fn(async () => releaseGate.promise);
    const hub = new FileDirectorySubscriptionHub({
      maxSubscriptions: 1,
      acquireScope: async () => release,
    });
    await hub.subscribe(subscriber("owner", "connection", "projects"));

    const repeatedCleanup = Array.from({ length: 100 }, () => (
      hub.unsubscribe("owner", "connection", "projects")
    ));
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(hub.subscriberCount).toBe(1);
    const rejected = await Promise.allSettled(Array.from({ length: 1_000 }, (_, index) => (
      hub.subscribe(subscriber(`owner-${index}`, `connection-${index}`, "projects"))
    )));
    expect(rejected.every((result) => result.status === "rejected")).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(1);

    releaseGate.resolve();
    await expect(Promise.all(repeatedCleanup)).resolves.toEqual(Array(100).fill(true));
    expect(hub.subscriberCount).toBe(0);
    await hub.close();
  });

  it("keeps stale releasing scopes counted until replacements acquire", async () => {
    let now = 0;
    let liveScopes = 0;
    let peakLiveScopes = 0;
    const releaseGate = deferred<void>();
    const hub = new FileDirectorySubscriptionHub({
      maxSubscriptions: 2,
      now: () => now,
      acquireScope: async () => {
        liveScopes += 1;
        peakLiveScopes = Math.max(peakLiveScopes, liveScopes);
        return async () => {
          await releaseGate.promise;
          liveScopes -= 1;
        };
      },
    });
    await hub.subscribe(subscriber("owner-a", "connection-a", "projects"));
    await hub.subscribe(subscriber("owner-b", "connection-b", "projects"));

    now = FILE_DIRECTORY_STALE_TTL_MS;
    const firstReplacement = hub.subscribe(subscriber("owner-c", "connection-c", "projects"));
    const secondReplacement = hub.subscribe(subscriber("owner-d", "connection-d", "projects"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(peakLiveScopes).toBe(2);
    expect(liveScopes).toBe(2);

    releaseGate.resolve();
    await Promise.all([firstReplacement, secondReplacement]);
    expect(peakLiveScopes).toBe(2);
    await hub.close();
  });

  it("drains a pending scope acquisition during close", async () => {
    const acquisitionGate = deferred<() => void>();
    const release = vi.fn();
    const hub = new FileDirectorySubscriptionHub({
      acquireScope: async () => acquisitionGate.promise,
    });
    const subscribePromise = hub.subscribe(subscriber("owner", "connection", "projects"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    let closeSettled = false;
    const closePromise = hub.close().then(() => { closeSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);

    acquisitionGate.resolve(release);
    await closePromise;
    await expect(subscribePromise).rejects.toThrow(/closed|no longer active/);
    expect(release).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(0);
  });

  it("reserves before authorization so connection removal cancels pending work", async () => {
    const authorizationGate = deferred<boolean>();
    const acquireScope = vi.fn(async () => vi.fn());
    const hub = new FileDirectorySubscriptionHub({
      authorize: async () => authorizationGate.promise,
      acquireScope,
    });
    const pending = hub.subscribe(subscriber("owner", "connection", "projects"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const removal = hub.removeConnection("owner", "connection");
    authorizationGate.resolve(true);
    await removal;
    await expect(pending).rejects.toThrow(/no longer active|cancel/i);
    expect(acquireScope).not.toHaveBeenCalled();
    expect(hub.subscriberCount).toBe(0);
    await hub.close();
  });

  it("lets exact unsubscribe cancel a pending authorization atomically", async () => {
    const authorizationGate = deferred<boolean>();
    const acquireScope = vi.fn(async () => vi.fn());
    const hub = new FileDirectorySubscriptionHub({
      authorize: async () => authorizationGate.promise,
      acquireScope,
    });
    const pending = hub.subscribe(subscriber("owner", "connection", "projects"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const unsubscribe = hub.unsubscribe("owner", "connection", "projects");
    authorizationGate.resolve(true);
    await expect(unsubscribe).resolves.toBe(true);
    await expect(pending).rejects.toThrow(/no longer active|cancel/i);
    expect(acquireScope).not.toHaveBeenCalled();
    await hub.close();
  });

  it("counts pending authorizations against global, connection, and owner caps", async () => {
    const authorizationGate = deferred<boolean>();
    const authorize = vi.fn(async ({ directory }: { directory: string }) => (
      directory === "projects" ? authorizationGate.promise : true
    ));
    const hub = new FileDirectorySubscriptionHub({
      authorize,
      acquireScope: async () => vi.fn(),
      maxSubscriptions: 3,
      maxDirectoriesPerConnection: 1,
      maxConnectionsPerOwner: 1,
    });
    const pending = hub.subscribe(subscriber("owner", "connection", "projects"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(hub.subscribe(subscriber("owner", "connection", "other")))
      .rejects.toThrow(/directory limit/i);
    await expect(hub.subscribe(subscriber("owner", "other-connection", "other")))
      .rejects.toThrow(/connection limit/i);
    await expect(hub.subscribe(subscriber("other-owner", "other-connection", "other")))
      .resolves.toBe(0);
    await expect(hub.subscribe(subscriber("third-owner", "third-connection", "other")))
      .resolves.toBe(0);
    await expect(hub.subscribe(subscriber("overflow-owner", "overflow-connection", "other")))
      .rejects.toThrow(/subscription limit/i);

    authorizationGate.resolve(true);
    await pending;
    await hub.close();
  });

  it("shares one pending initialization for concurrent exact-key subscribes", async () => {
    const authorizationGate = deferred<boolean>();
    const authorize = vi.fn(async () => authorizationGate.promise);
    const acquireScope = vi.fn(async () => vi.fn());
    const hub = new FileDirectorySubscriptionHub({ authorize, acquireScope });
    const first = hub.subscribe(subscriber("owner", "connection", "projects"));
    const second = hub.subscribe(subscriber("owner", "connection", "projects"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(authorize).toHaveBeenCalledOnce();
    authorizationGate.resolve(true);
    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
    expect(acquireScope).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(1);
    await hub.close();
  });

  it("shares one replacement after concurrent exact-key cleanup waiters", async () => {
    const releaseGate = deferred<void>();
    const acquireScope = vi.fn()
      .mockResolvedValueOnce(async () => releaseGate.promise)
      .mockResolvedValue(async () => vi.fn());
    const hub = new FileDirectorySubscriptionHub({ acquireScope });
    await hub.subscribe(subscriber("owner", "connection", "projects"));
    const cleanup = hub.unsubscribe("owner", "connection", "projects");
    const first = hub.subscribe(subscriber("owner", "connection", "projects"));
    const second = hub.subscribe(subscriber("owner", "connection", "projects"));

    releaseGate.resolve();
    await Promise.all([cleanup, first, second]);
    expect(acquireScope).toHaveBeenCalledTimes(2);
    expect(hub.subscriberCount).toBe(1);
    await hub.close();
  });

  it("waits for and cancels authorization when close begins", async () => {
    const authorizationGate = deferred<boolean>();
    const acquireScope = vi.fn(async () => vi.fn());
    const hub = new FileDirectorySubscriptionHub({
      authorize: async () => authorizationGate.promise,
      acquireScope,
    });
    const pending = hub.subscribe(subscriber("owner", "connection", "projects"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    let closeSettled = false;
    const closePromise = hub.close().then(() => { closeSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);

    authorizationGate.resolve(true);
    await closePromise;
    await expect(pending).rejects.toThrow(/closed|no longer active|cancel/i);
    expect(acquireScope).not.toHaveBeenCalled();
  });

  it("authorizes before scope installation and resubscribes idempotently", async () => {
    const authorize = vi.fn(async () => true);
    const acquireScope = vi.fn(async () => vi.fn());
    const firstSend = vi.fn();
    const hub = new FileDirectorySubscriptionHub({ authorize, acquireScope });

    expect(await hub.subscribe(subscriber("owner", "connection", "projects", firstSend))).toBe(0);
    expect(await hub.subscribe(subscriber("owner", "connection", "projects", vi.fn()))).toBe(0);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(acquireScope).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(1);
    await hub.close();
  });

  it("delivers only direct-child hints with monotonic revisions and resets on reconnect", async () => {
    const firstSend = vi.fn();
    const hub = new FileDirectorySubscriptionHub({ acquireScope: async () => () => {} });
    expect(await hub.subscribe(subscriber("owner", "connection-a", "projects", firstSend))).toBe(0);

    await hub.broadcast({ type: "file:change", path: "projects/demo", event: "add" });
    await hub.broadcast({ type: "file:change", path: "projects/demo/nested.txt", event: "change" });
    await hub.broadcast({ type: "file:change", path: "other/file.txt", event: "unlink" });
    await hub.broadcast({ type: "file:change", path: "projects/.env", event: "change" });
    await hub.broadcast({ type: "file:change", path: "projects/readme.md", event: "change" });
    expect(firstSend.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { type: "files:change", directory: "projects", entry: "demo", event: "add", revision: 1 },
      { type: "files:change", directory: "projects", entry: "readme.md", event: "change", revision: 2 },
    ]);
    expect(await hub.subscribe(subscriber("owner", "connection-a", "projects", firstSend))).toBe(2);

    await hub.removeConnection("owner", "connection-a");
    const reconnectSend = vi.fn();
    expect(await hub.subscribe(subscriber("owner", "connection-b", "projects", reconnectSend))).toBe(0);
    await hub.broadcast({ type: "file:change", path: "projects/again", event: "unlink" });
    expect(JSON.parse(reconnectSend.mock.calls[0][0]).revision).toBe(1);
    await hub.close();
  });

  it("isolates failed sends, evicts their scopes, and continues broadcasting", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failedRelease = vi.fn();
    const healthyRelease = vi.fn();
    const releases = [failedRelease, healthyRelease];
    const failedSend = vi.fn(() => { throw new Error("/private/owner/socket failed"); });
    const healthySend = vi.fn();
    const hub = new FileDirectorySubscriptionHub({
      acquireScope: async () => releases.shift() ?? vi.fn(),
    });
    await hub.subscribe(subscriber("owner-a", "connection-a", "projects", failedSend));
    await hub.subscribe(subscriber("owner-b", "connection-b", "projects", healthySend));

    await hub.broadcast({ type: "file:change", path: "projects/readme.md", event: "change" });
    expect(healthySend).toHaveBeenCalledOnce();
    expect(failedRelease).toHaveBeenCalledOnce();
    expect(healthyRelease).not.toHaveBeenCalled();
    expect(hub.subscriberCount).toBe(1);

    await hub.broadcast({ type: "file:change", path: "projects/again.md", event: "change" });
    expect(failedSend).toHaveBeenCalledOnce();
    expect(healthySend).toHaveBeenCalledTimes(2);
    expect(consoleSpy.mock.calls.flat().join(" ")).not.toContain("/private/owner");
    await hub.close();
  });

  it("removes whole connections and drains shutdown once with no post-close work", async () => {
    const sends = [vi.fn(), vi.fn()];
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const pendingReleases = [firstRelease, secondRelease];
    const acquireScope = vi.fn(async () => pendingReleases.shift()!);
    const hub = new FileDirectorySubscriptionHub({ acquireScope });
    await hub.subscribe(subscriber("owner", "connection", "projects", sends[0]));
    await hub.subscribe(subscriber("owner", "connection", "apps", sends[1]));

    await hub.close();
    await hub.close();
    expect(sends.map((send) => JSON.parse(send.mock.calls[0][0]))).toEqual([
      { type: "files:shutdown" },
      { type: "files:shutdown" },
    ]);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(0);
    await expect(hub.subscribe(subscriber("owner", "connection", "projects")))
      .rejects.toThrow("closed");
    await hub.broadcast({ type: "file:change", path: "projects/nope", event: "add" });
    expect(acquireScope).toHaveBeenCalledTimes(2);
  });
});
