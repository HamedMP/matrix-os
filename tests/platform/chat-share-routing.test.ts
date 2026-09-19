import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import {
  deleteContainer,
  insertUserMachine,
  type PlatformDB,
} from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import {
  cleanupProxyRoutingTest,
  setupProxyRoutingTest,
  stubOrchestrator,
} from "./proxy-routing-test-utils.js";

const SCOPE_ID = "6aed8d12-f6c8-4c10-90b2-1e51fcc738e3";
const SNAPSHOT_TOKEN = "a".repeat(64);

describe("shared chat platform routing", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    db = await setupProxyRoutingTest();
    await deleteContainer(db, "alice");
    await insertUserMachine(db, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff200",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      hetznerServerId: 123499,
      publicIPv4: "203.0.113.69",
      imageVersion: "matrix-os-host-2026.09.17-1",
      provisionedAt: "2026-09-17T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    await cleanupProxyRoutingTest(db);
  });

  function createAuthenticatedApp() {
    return createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({
        verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }),
      }),
      platformSecret: "platform-secret-123",
    });
  }

  it("keeps exact public snapshot routes on the snapshot proxy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        title: "Shared snapshot",
        messages: [{ role: "user", text: "Hello" }],
      }),
    );
    const app = createAuthenticatedApp();

    const response = await app.request(
      `/shared/chat/alice/primary/${SNAPSHOT_TOKEN}`,
      { headers: { host: "app.matrix-os.com" } },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://203.0.113.69:443/api/share/chats/${SNAPSHOT_TOKEN}`,
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull();
  });

  it("routes authenticated live shared chats to the recipient VPS shell", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("live shared chat", { status: 200 }),
    );
    const app = createAuthenticatedApp();

    const response = await app.request(`/shared/chat/${SCOPE_ID}`, {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("live shared chat");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://203.0.113.69:443/shared/chat/${SCOPE_ID}`,
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-platform-user-id")).toBe("user_alice");
    expect(headers.get("x-platform-verified")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps explicit VPS live shared chat routes working", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("explicit live shared chat", { status: 200 }),
    );
    const app = createAuthenticatedApp();

    const response = await app.request(`/vm/alice/shared/chat/${SCOPE_ID}`, {
      headers: {
        host: "app.matrix-os.com",
        authorization: "Bearer clerk-session",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("explicit live shared chat");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://203.0.113.69:443/shared/chat/${SCOPE_ID}`,
    );
  });

  it("does not let a snapshot token authenticate a malformed snapshot-like route", async () => {
    const verifyToken = vi.fn().mockRejectedValue(new Error("invalid Clerk token"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unauthorized shell access", { status: 200 }),
    );
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken }),
      platformSecret: "platform-secret-123",
    });

    const response = await app.request(
      `/shared/chat/alice/primary/${SNAPSHOT_TOKEN.slice(1)}`,
      {
        headers: {
          host: "app.matrix-os.com",
          authorization: `Bearer ${SNAPSHOT_TOKEN}`,
        },
      },
    );

    expect(verifyToken).toHaveBeenCalledWith(SNAPSHOT_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("unauthorized shell access");
  });
});
