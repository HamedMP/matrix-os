import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { deleteContainer, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPostAuthRedirectPath, createApp } from "../../packages/platform/src/main.js";
import {
  cleanupProxyRoutingTest, cookieHeaderFromSetCookie, JWT_SECRET, setupProxyRoutingTest, stubOrchestrator,
} from "./proxy-routing-test-utils.js";

let db: PlatformDB;
beforeEach(async () => { db = await setupProxyRoutingTest(); });
afterEach(async () => { await cleanupProxyRoutingTest(db); });

it.each([
  { flow: "confirm", selector: "challenge", id: `rcact_${"a".repeat(32)}` },
  { flow: "full-access", selector: "chat", id: "chat_source" },
])("carries the exact Electron $flow link through VPS-only signed-out HTTP and browser session exchange", async ({ flow, selector, id }) => {
  process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "false";
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_matrix");
  onTestFinished(() => vi.unstubAllEnvs());
  await deleteContainer(db, "alice");
  await insertUserMachine(db, {
    machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff140",
    clerkUserId: "user_alice", handle: "alice-staging", runtimeSlot: "staging", status: "running",
    hetznerServerId: 123484, publicIPv4: "203.0.113.35", imageVersion: "matrix-os-host-2026.05.31-1",
    serverType: "cpx22", provisionedAt: "2026-05-31T12:05:00.000Z",
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    if (String(url).startsWith("http://127.0.0.1:3200/")) return new Response(null, {
      status: 307, headers: { location: "/sign-in?redirect_url=" + encodeURIComponent(String(url)) },
    });
    return new Response("Confirmation page", { status: 200 });
  });
  const app = createApp({
    db, orchestrator: stubOrchestrator(), platformSecret: "platform-secret-123",
    clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }) }),
  });
  const path = `/vm/alice-staging/routine-cli/${flow}`;
  const link = `${path}?runtime=staging&${selector}=${id}`;
  const response = await app.request(link, { headers: { host: "app.matrix-os.com" } });
  expect(response.status).toBe(200);
  const html = await response.text();
  const redirect = /var redirectTarget = ("[^"\n]*");/.exec(html)?.[1];
  expect(redirect).toBeDefined();
  expect(JSON.parse(redirect!)).toBe(link);
  expect(html).toContain("forceRedirectUrl: redirectTarget");
  expect(fetchMock).not.toHaveBeenCalled();

  const exchange = (redirectTo: string) => app.request("/api/auth/app-session", {
    method: "POST", headers: { host: "app.matrix-os.com", authorization: "Bearer clerk-session", "content-type": "application/json" },
    body: JSON.stringify({ redirectTo, runtime: "staging" }),
  });
  const session = await exchange(JSON.parse(redirect!));
  expect(session.status).toBe(200);
  await expect(session.json()).resolves.toEqual({ redirectTo: link });
  const cookie = cookieHeaderFromSetCookie(session.headers, ["matrix_app_session"]);
  const final = await app.request(link, { headers: { host: "app.matrix-os.com", cookie } });
  expect(final.status).toBe(200);
  expect(fetchMock.mock.lastCall?.[0]).toBe(`https://203.0.113.35:443/routine-cli/${flow}?${selector}=${id}`);

  for (const invalid of [
    `https://evil.example${link}`, `//evil.example${link}`,
    `${path}?runtime=staging&${selector}=invalid`, `${path}?runtime=invalid_runtime&${selector}=${id}`,
    `${link}&%63${selector.slice(1)}=${id}`, `${link}&runtime=primary`, `${link}&next=https://evil.example`, `${link}#external`,
  ]) {
    const result = await exchange(invalid);
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ redirectTo: "/" });
  }
  const nested = (target: string) => buildPostAuthRedirectPath(`https://app.matrix-os.com/sign-in?redirect_url=${encodeURIComponent(target)}`);
  expect(nested(link)).toBe(link);
  expect(nested(`${path}?${selector}=${id}`)).toBe(`${path}?${selector}=${id}`);
  expect(nested(`https://evil.example${link}`)).toBe("/");
  expect(nested(`${link}&${selector}=${id}`)).toBe("/");
});
