import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { createApp } from "../../packages/platform/src/main.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { APP_SESSION_COOKIE } from "../../packages/platform/src/session-cookies.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { createMessagingHandoffRoutes } from "../../packages/platform/src/whatsapp/handoff-routes.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import { JWT_SECRET, stubOrchestrator } from "./proxy-routing-test-utils.js";

const chatId = "chat_whatsapp";
const owner = "user_alice";
const primaryIp = "203.0.113.20";
const reviewIp = "203.0.113.21";
let db: PlatformDB;

async function machine(slot: string, options: { status?: "running" | "stopped"; owner?: string; preview?: boolean } = {}) {
  await insertUserMachine(db, {
    machineId: slot === "primary" ? "00000000-0000-4000-8000-000000002001" : "00000000-0000-4000-8000-000000002002",
    clerkUserId: options.owner ?? owner,
    handle: slot === "primary" ? "alice-main" : "alice-review",
    runtimeSlot: slot,
    provisioningClass: options.preview ? "preview" : "customer",
    status: options.status ?? "running",
    hetznerServerId: slot === "primary" ? 100 : 101,
    publicIPv4: slot === "primary" ? primaryIp : reviewIp,
    imageVersion: "dev",
    serverType: "cpx22",
    provisionedAt: "2026-07-16T00:00:00.000Z",
  });
}

async function setup() {
  const token = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: owner,
    handle: "alice-review", gatewayUrl: "https://app.matrix-os.com/vm/alice-review",
    runtimeSlot: "review", sessionProvenance: "clerk-browser" });
  const headers = { host: "app.matrix-os.com", cookie: `${APP_SESSION_COOKIE}=${encodeURIComponent(token.token)}` };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    String(url).includes("/api/chats/") ? Response.json({ chatId, owner }) : new Response("Matrix shell"));
  const app = createApp({ db, orchestrator: stubOrchestrator(),
    clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
    platformSecret: "platform-secret-123", whatsappRoutes: createMessagingHandoffRoutes() });
  const html = await (await app.request(`/open?chat=${chatId}`)).text();
  const fallback = html.match(/class="secondary" href="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
  return { app, headers, fetchMock, fallback };
}

beforeEach(async () => {
  vi.stubEnv("PLATFORM_JWT_SECRET", JWT_SECRET);
  vi.stubEnv("MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED", "false");
  ({ db } = await createTestPlatformDb());
  await machine("review");
});
afterEach(async () => {
  await destroyTestPlatformDb(db);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("WhatsApp browser handoff from an additional computer", () => {
  it("selects the verified owner's primary before the real Chat request", async () => {
    await machine("primary");
    const { app, headers, fetchMock, fallback } = await setup();
    const navigation = await app.request(fallback, { headers });
    expect(navigation.status).toBe(302);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigation.headers.get("cache-control")).toContain("no-store");
    const target = new URL(navigation.headers.get("location")!, "https://app.matrix-os.com");
    expect(target.pathname).toBe("/vm/alice-main");
    expect(target.searchParams.get("chat")).toBe(chatId);
    expect(target.searchParams.get("runtime")).toBe("primary");
    expect((await app.request(target.pathname + target.search, { headers })).status).toBe(200);
    const detail = await app.request(`/vm/alice-main/~runtime/primary/api/chats/${chatId}`, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual({ chatId, owner });
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith(`https://${primaryIp}:443/`))).toBe(true);
    const forwarded = new Headers(fetchMock.mock.calls.at(-1)![1]?.headers);
    expect(forwarded.get("x-platform-user-id")).toBe(owner);
  });

  it.each(["missing", "stopped", "preview", "foreign"] as const)(
    "fails closed when the primary is %s, even with an available additional computer", async (state) => {
      if (state !== "missing") await machine("primary", {
        ...(state === "stopped" ? { status: "stopped" } : {}),
        ...(state === "preview" ? { preview: true } : {}),
        ...(state === "foreign" ? { owner: "user_bob" } : {}),
      });
      const { app, headers, fetchMock, fallback } = await setup();
      const response = await app.request(fallback, { headers });
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("retains signed runtime authority for ordinary API queries", async () => {
    await machine("primary");
    const { app, headers, fetchMock } = await setup();
    expect((await app.request(`/api/chats/${chatId}?runtime=primary`, { headers })).status).toBe(200);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(reviewIp);
  });

  it.each([
    "chat=../../private&launch=__chat__&runtime=primary",
    `chat=${chatId}&chat=chat_second&launch=__chat__&runtime=primary`,
    `chat=${chatId}&launch=__chat__&runtime=primary&runtime=review`,
    `chat=${chatId}&launch=__chat__&runtime=primary&next=https://example.test`,
  ])("rejects invalid or ambiguous handoff navigation: %s", async (query) => {
    await machine("primary");
    const { app, headers, fetchMock } = await setup();
    const response = await app.request(`/?${query}`, { headers });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not redirect unrelated root navigations", async () => {
    await machine("primary");
    const { app, headers, fetchMock } = await setup();
    expect((await app.request("/?runtime=primary", { headers })).status).toBe(200);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(reviewIp);
  });
});
