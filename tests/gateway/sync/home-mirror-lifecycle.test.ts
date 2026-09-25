import { describe, expect, it, vi } from "vitest";
import { createGatewayHomeMirrorLifecycle } from "../../../packages/gateway/src/sync/home-mirror-lifecycle.js";
import type { HomeMirror } from "../../../packages/gateway/src/sync/home-mirror.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("gateway home mirror lifecycle", () => {
  it("reports failed when enabled without sync infrastructure", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const lifecycle = createGatewayHomeMirrorLifecycle({
      enabled: true,
      homeRoot: "/home/matrix/home",
      syncR2: null,
      kyselyInstance: null,
      peerRegistry: null,
      env: {},
      logger,
    });

    expect(lifecycle.readiness.getStatus()).toEqual({ state: "failed" });
    expect(lifecycle.startup).toBeNull();
  });

  it("stops a partially started mirror before reporting startup failure", async () => {
    const start = deferred<void>();
    const mirror: HomeMirror = {
      start: vi.fn(() => start.promise),
      stop: vi.fn(async () => {}),
      pushLocalFile: vi.fn(async () => {}),
      pushLocalDelete: vi.fn(async () => {}),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const lifecycle = createGatewayHomeMirrorLifecycle({
      enabled: true,
      homeRoot: "/home/matrix/home",
      syncR2: {} as never,
      kyselyInstance: {} as never,
      peerRegistry: null,
      env: { MATRIX_USER_ID: "user_123" },
      logger,
      createMirror: () => mirror,
    });

    start.reject(new Error("initial push failed"));
    await lifecycle.startup;

    expect(mirror.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.readiness.getStatus()).toEqual({ state: "failed" });
    expect(logger.error).toHaveBeenCalledWith(
      "[home-mirror] start failed:",
      "initial push failed",
    );
  });
});
