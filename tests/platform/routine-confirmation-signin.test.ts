import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { deleteContainer, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPostAuthRedirectPath, createApp } from "../../packages/platform/src/main.js";
import {
  cleanupProxyRoutingTest, cookieHeaderFromSetCookie, JWT_SECRET, setupProxyRoutingTest, stubOrchestrator,
} from "./proxy-routing-test-utils.js";

let db: PlatformDB;
beforeEach(async () => { db = await setupProxyRoutingTest(); });
afterEach(async () => { await cleanupProxyRoutingTest(db); });

it("carries the exact Electron routine confirmation through signed-out HTTP and browser session exchange", async ({ onTestFinished }) => {
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
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("Confirmation page", { status: 200 }));
  const app = createApp({
    db, orchestrator: stubOrchestrator(), platformSecret: "platform-secret-123",
    clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }) }),
  });
  const challenge = `rcact_${"a".repeat(32)}`;
  const path = "/vm/alice-staging/routine-cli/confirm";
  const link = `${path}?runtime=staging&challenge=${challenge}`;
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
  expect(fetchMock.mock.lastCall?.[0]).toBe(`https://203.0.113.35:443/routine-cli/confirm?challenge=${challenge}`);

  for (const invalid of [
    `https://evil.example${link}`, `//evil.example${link}`,
    `${path}?runtime=staging&challenge=invalid`, `${path}?runtime=invalid_runtime&challenge=${challenge}`,
    `${link}&%63hallenge=${challenge}`, `${link}&runtime=primary`, `${link}&next=https://evil.example`, `${link}#external`,
  ]) {
    const result = await exchange(invalid);
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ redirectTo: "/" });
  }
  const nested = (target: string) => buildPostAuthRedirectPath(`https://app.matrix-os.com/sign-in?redirect_url=${encodeURIComponent(target)}`);
  expect(nested(link)).toBe(link);
  expect(nested(`${path}?challenge=${challenge}`)).toBe(`${path}?challenge=${challenge}`);
  expect(nested(`https://evil.example${link}`)).toBe("/");
  expect(nested(`${link}&challenge=${challenge}`)).toBe("/");
});
