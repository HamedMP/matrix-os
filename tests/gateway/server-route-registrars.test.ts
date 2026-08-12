import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppRuntimeRoutes } from "../../packages/gateway/src/server/app-runtime-routes.js";
import { registerFileRoutes } from "../../packages/gateway/src/server/file-routes.js";
import { registerFileManagementRoutes } from "../../packages/gateway/src/server/file-management-routes.js";
import { FileBatchMoveService } from "../../packages/gateway/src/file-management/batch-service.js";
import {
  FileOperationResultCache,
  type FileOperationCacheInput,
} from "../../packages/gateway/src/file-management/result-cache.js";
import type { BatchMovePreflightResult } from "../../packages/gateway/src/file-management/preflight.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class PrincipalCapturingResultCache extends FileOperationResultCache {
  input: FileOperationCacheInput | undefined;
  private resolveStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });
  private resolvePending!: (value: unknown) => void;
  private readonly pending = new Promise<unknown>((resolve) => { this.resolvePending = resolve; });

  override run<T>(input: FileOperationCacheInput, _operation: () => Promise<T>): Promise<T> {
    this.input = input;
    this.resolveStarted();
    return this.pending as Promise<T>;
  }

  resolve(value: unknown): void {
    this.resolvePending(value);
  }
}

describe("gateway server route registrars", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    vi.unstubAllEnvs();
  });

  it("wires app runtime boundary validation through the extracted registrar", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "gateway-app-routes-"));
    cleanupPaths.push(homePath);
    const app = new Hono();
    const processManager = registerAppRuntimeRoutes(app, {
      homePath,
      appSessionMasterSecret: "test-secret-with-enough-entropy",
      devAppAuthBypass: true,
      publicHost: "localhost",
      onAppError: () => {},
    });

    try {
      const res = await app.request("/api/apps/bad!/manifest");

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "invalid slug" });
    } finally {
      await processManager.shutdownAll();
    }
  });

  it("wires file route query validation through the extracted registrar", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "gateway-file-routes-"));
    cleanupPaths.push(homePath);
    const app = new Hono();
    registerFileRoutes(app, {
      homePath,
      trashService: {
        trash: async () => ({ results: [], sourceDirectory: "." }),
        delete: async () => ({ ok: false }),
        list: async () => ({ entries: [] }),
        restore: async () => ({ ok: false }),
        empty: async () => ({ ok: true, deleted: 0 }),
        close: async () => {},
      },
    });

    const res = await app.request("/api/files/search");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "q required" });
  });

  it("registers file-management routes after auth and closes them before shared watcher dependencies", () => {
    const source = readFileSync(join(process.cwd(), "packages/gateway/src/server.ts"), "utf8");
    const authIndex = source.indexOf('app.use("*", authMiddleware');
    const registrationIndex = source.indexOf("const fileManagementRoutes = registerFileManagementRoutes(");
    const closeIndex = source.indexOf("await fileManagementRoutes.close()");
    const watcherCloseIndex = source.indexOf("await watcher.close()");

    expect(authIndex).toBeGreaterThan(-1);
    expect(registrationIndex).toBeGreaterThan(authIndex);
    expect(closeIndex).toBeGreaterThan(registrationIndex);
    expect(watcherCloseIndex).toBeGreaterThan(closeIndex);
    expect(source).toContain("getOwnerId: (c) => requireRequestPrincipal(c).userId");
    expect(source).toContain("trashService: fileManagementRoutes.trashService");
  });

  it("composes production auth, canonical owner identity, and draining route close", async () => {
    const jwtSecret = "test-secret-at-least-32-characters-long";
    vi.stubEnv("PLATFORM_JWT_SECRET", jwtSecret);
    vi.stubEnv("MATRIX_HANDLE", "alice");
    vi.stubEnv("MATRIX_RUNTIME_SLOT", "primary");
    const issued = await issueSyncJwt({
      secret: jwtSecret,
      clerkUserId: "user_real",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com/vm/alice",
      runtimeSlot: "primary",
    });
    const resultCache = new PrincipalCapturingResultCache();
    const moveService = new FileBatchMoveService({ resultCache });
    const app = new Hono();
    app.use("*", authMiddleware("legacy-shared-secret"));
    const registry = registerFileManagementRoutes(app, {
      homePath: "/owner/home",
      getOwnerId: (c) => requireRequestPrincipal(c).userId,
      createMoveService: () => moveService,
      trashService: {
        trash: vi.fn(), delete: vi.fn(), list: vi.fn(), restore: vi.fn(), empty: vi.fn(), close: vi.fn(),
      },
    });
    const body = {
      requestId,
      phase: "preflight",
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    };
    const authHeaders = {
      authorization: `Bearer ${issued.token}`,
      "content-type": "application/json",
      "x-owner-id": "user_attacker",
    };

    const unauthorized = await app.request("/api/files/batch/move", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const spoofedBody = await app.request("/api/files/batch/move", {
      method: "POST", headers: authHeaders, body: JSON.stringify({ ...body, ownerId: "user_attacker" }),
    });
    const inFlight = app.request("/api/files/batch/move", {
      method: "POST", headers: authHeaders, body: JSON.stringify(body),
    });
    await resultCache.started;
    const close = registry.close();
    let closeSettled = false;
    void close.then(() => { closeSettled = true; });
    await Promise.resolve();

    expect(unauthorized.status).toBe(401);
    expect(spoofedBody.status).toBe(400);
    expect(resultCache.input?.ownerId).toBe("user_real");
    expect(closeSettled).toBe(false);
    const preflight: BatchMovePreflightResult = {
      sources: body.sources,
      destinationDirectory: body.destinationDirectory,
      conflicts: [],
      invalid: [],
      preflightFingerprint: "fingerprint-a",
    };
    resultCache.resolve(preflight);
    expect((await inFlight).status).toBe(200);
    await close;
    const afterClose = await app.request("/api/files/batch/move", {
      method: "POST", headers: authHeaders, body: JSON.stringify(body),
    });

    expect(afterClose.status).toBe(503);
    await expect(afterClose.json()).resolves.toEqual({
      error: "File operation unavailable",
      code: "operation_unavailable",
    });
    resultCache.close();
  });
});
