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

function readAuthPageRedirect(html: string): string | undefined {
  const literal = /var redirectTarget = ("[^"\n]*");/.exec(html)?.[1];
  return literal === undefined ? undefined : JSON.parse(literal);
}

it.each([
  { name: "exact operation", flow: "confirm", query: `challenge=rcact_${"a".repeat(32)}` },
  { name: "Full Access", flow: "full-access", query: "chat=chat_source" },
  { name: "source Chat review", flow: "confirm", query: "originChat=chat_source&interaction=in_proposal_1" },
  { name: "source Chat creation", flow: null, query: "sourceChat=chat_source&launch=__chat__" },
])("carries the $name link through VPS-only signed-out HTTP and browser session exchange", async ({ flow, query }) => {
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
  const upstreamPath = flow === null ? "/" : `/routine-cli/${flow}`;
  const path = `/vm/alice-staging${flow === null ? "" : upstreamPath}`;
  const selectorParams = new URLSearchParams(query);
  const link = `${path}?runtime=staging&${selectorParams}`;
  const response = await app.request(link, { headers: { host: "app.matrix-os.com" } });
  expect(response.status).toBe(200);
  const html = await response.text();
  const redirect = readAuthPageRedirect(html);
  expect(redirect).toBe(link);
  expect(html).toContain("forceRedirectUrl: redirectTarget");
  if (flow === null) {
    const signIn = `/sign-in?redirect_url=${encodeURIComponent(link)}`;
    const nested = await app.request(signIn, { headers: { host: "app.matrix-os.com" } });
    expect(nested.status).toBe(200);
    expect(readAuthPageRedirect(await nested.text())).toBe(link);
  }
  expect(fetchMock).not.toHaveBeenCalled();

  const exchange = (redirectTo: string, runtime: string | null = "staging") => app.request("/api/auth/app-session", {
    method: "POST", headers: { host: "app.matrix-os.com", authorization: "Bearer clerk-session", "content-type": "application/json" },
    body: JSON.stringify({ redirectTo, runtime: runtime ?? undefined }),
  });
  const session = await exchange(redirect!);
  expect(session.status).toBe(200);
  await expect(session.json()).resolves.toEqual({ redirectTo: link });
  const cookie = cookieHeaderFromSetCookie(session.headers, ["matrix_app_session"]);
  const final = await app.request(link, { headers: { host: "app.matrix-os.com", cookie } });
  expect(final.status).toBe(200);
  expect(fetchMock.mock.lastCall?.[0]).toBe(`https://203.0.113.35:443${upstreamPath}?${selectorParams}`);

  const invalidSelectors = [...selectorParams].flatMap(([key, value]) => {
    const missing = new URLSearchParams(selectorParams), malformed = new URLSearchParams(selectorParams);
    missing.delete(key);
    malformed.set(key, "invalid");
    const encodedKey = `%${key.charCodeAt(0).toString(16)}${key.slice(1)}`;
    return [`${path}?runtime=staging&${missing}`, `${path}?runtime=staging&${malformed}`, `${link}&${encodedKey}=${value}`];
  });
  for (const invalid of [
    `https://evil.example${link}`, `//evil.example${link}`,
    `${path}?runtime=invalid_runtime&${selectorParams}`,
    `${link}&runtime=primary`, `${link}&next=https://evil.example`, `${link}#external`,
    ...invalidSelectors,
    ...(selectorParams.has("originChat") ? [`${link}&challenge=rcact_${"b".repeat(32)}`] : []),
  ]) {
    const result = await exchange(invalid);
    expect(result.status).toBe(200);
    if (flow === null) {
      const { redirectTo } = await result.json();
      expect(redirectTo).toMatch(/^\/(?:vm\/alice-staging(?:\?runtime=staging)?)?$/);
    } else {
      await expect(result.json()).resolves.toEqual({ redirectTo: "/" });
    }
  }
  if (flow === null) {
    const withoutRuntime = `${path}?${selectorParams}`;
    const optionalRuntimePage = await app.request(withoutRuntime, { headers: { host: "app.matrix-os.com" } });
    expect(optionalRuntimePage.status).toBe(200);
    expect(readAuthPageRedirect(await optionalRuntimePage.text())).toBe(withoutRuntime);
    const optionalRuntimeSession = await exchange(withoutRuntime, null);
    expect(optionalRuntimeSession.status).toBe(200);
    await expect(optionalRuntimeSession.json()).resolves.toEqual({ redirectTo: withoutRuntime });

    await insertUserMachine(db, {
      machineId: "7539f06f-780a-4796-bb58-5328118e1ecb",
      clerkUserId: "user_bob", handle: "bob-staging", runtimeSlot: "staging", status: "running",
      hetznerServerId: 123485, publicIPv4: "203.0.113.36", imageVersion: "matrix-os-host-2026.05.31-1",
      serverType: "cpx22", provisionedAt: "2026-05-31T12:05:00.000Z",
    });
    const otherComputer = await app.request(link.replace("/alice-staging?", "/bob-staging?"), {
      headers: { host: "app.matrix-os.com", cookie },
    });
    expect(otherComputer.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const normalizedAlias = await exchange(`/vm/other/../alice-staging?runtime=staging&${selectorParams}`);
    await expect(normalizedAlias.json()).resolves.toEqual({ redirectTo: "/vm/alice-staging?runtime=staging" });
    const ordinary = await app.request(`/sign-in?redirect_url=${encodeURIComponent(`${path}?launch=__files__`)}`, {
      headers: { host: "app.matrix-os.com" },
    });
    expect(ordinary.status).toBe(307);
    expect(fetchMock.mock.lastCall?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:3200\/sign-in/);
  }
  const nested = (target: string) => buildPostAuthRedirectPath(`https://app.matrix-os.com/sign-in?redirect_url=${encodeURIComponent(target)}`);
  expect(nested(link)).toBe(link);
  expect(nested(`${path}?${selectorParams}`)).toBe(`${path}?${selectorParams}`);
  expect(nested(`https://evil.example${link}`)).toBe("/");
  for (const invalid of invalidSelectors) expect(nested(invalid)).toBe("/");
});
