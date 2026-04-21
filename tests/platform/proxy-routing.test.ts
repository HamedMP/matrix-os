import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createPlatformDb, type PlatformDB, insertContainer } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import * as syncJwt from "../../packages/platform/src/sync-jwt.js";

const JWT_SECRET = "test-secret-at-least-32-characters-long";

function stubOrchestrator(): Orchestrator {
  return {
    provision: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    destroy: vi.fn(),
    upgrade: vi.fn(),
    rollingRestart: vi.fn(),
    getInfo: vi.fn((handle: string) => ({
      handle,
      clerkUserId: "user_alice",
      containerId: "ctr-1",
      port: 5001,
      shellPort: 6001,
      status: "running",
    })),
    getImage: vi.fn(),
    listAll: vi.fn().mockReturnValue([]),
    syncStates: vi.fn(),
  };
}

describe("platform proxy routing", () => {
  let tmpDir: string;
  let db: PlatformDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "platform-proxy-"));
    db = createPlatformDb(join(tmpDir, "test.db"));
    insertContainer(db, {
      handle: "alice",
      clerkUserId: "user_alice",
      port: 5001,
      shellPort: 6001,
      status: "running",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.PLATFORM_JWT_SECRET;
  });

  it("adds a timeout and a derived platform verification token on app-domain proxy fetches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/ping", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
        cookie: "__session=clerk-cookie; other=session",
      },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toBeInstanceOf(Headers);
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeTruthy();
    expect(headers.get("authorization")).not.toBe("Bearer platform-secret-123");
    expect(headers.get("x-platform-user-id")).toBe("user_alice");
    expect(headers.get("cookie")).toBeNull();
  });

  it("routes sync JWT bearer requests through app.matrix-os.com to the matching container", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "alice",
      gatewayUrl: "https://app.matrix-os.com",
    });

    const res = await app.request("/api/sync/manifest", {
      headers: {
        host: "app.matrix-os.com",
        authorization: `Bearer ${issued.token}`,
      },
    });

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://matrixos-alice:4000/api/sync/manifest");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeTruthy();
    expect(headers.get("x-platform-user-id")).toBe("user_alice");
  });

  it("returns 500 when sync JWT verification fails unexpectedly", async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    vi.spyOn(syncJwt, "verifySyncJwt").mockRejectedValueOnce(new Error("db unavailable"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/api/sync/manifest", {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clearly-a-token",
      },
    });

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds a timeout on /proxy/:handle fetches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
    });

    const res = await app.request("/proxy/alice/api/ping", {
      headers: { authorization: "Bearer platform-secret-123" },
    });

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("manual");
  });
});
