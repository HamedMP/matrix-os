import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PlatformDB, insertUserMachine } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { isSharedEntryPath } from "../../packages/contracts/src/collaboration-entry.js";
import {
  isSharedEntryDocumentRequest,
  resolveSharedEntryTarget,
} from "../../packages/platform/src/shared-entry-routing.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const SCOPE_ID = "7f3c2b8e-4d1a-4c6b-9e2f-1a2b3c4d5e6f";
const AUTH_SHELL = "http://auth-shell.test:3200";
const VPS_ORIGIN = "https://203.0.113.40:443";

const BASE_ENV = {
  MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: "false",
  AUTH_SHELL_HOST: "auth-shell.test",
  AUTH_SHELL_PORT: "3200",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_matrix",
} as const;

const runningMachine = {
  machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff201",
  clerkUserId: "user_member",
  handle: "member",
  runtimeSlot: "primary",
  status: "running",
  hetznerServerId: 123501,
  publicIPv4: "203.0.113.40",
  imageVersion: "matrix-os-host-2026.09.27-1",
  provisionedAt: "2026-09-27T12:00:00.000Z",
} as const;

function mockUpstreams() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith(AUTH_SHELL)) {
      return new Response("<main data-frame>platform frame</main>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("vps shell", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
}

function buildApp(db: PlatformDB, env: Record<string, string> = {}, userId = "user_member") {
  return createApp({
    db,
    orchestrator: {} as never,
    clerkAuth: createClerkAuth({
      verifyToken: vi.fn().mockResolvedValue({ sub: userId }),
    }),
    platformSecret: "platform-secret-123",
    env: { ...BASE_ENV, ...env } as NodeJS.ProcessEnv,
  });
}

function signedIn(host = "app.matrix-os.com"): RequestInit {
  return { headers: { host, cookie: "__session=clerk-member" } };
}

function fetchTargets(fetchMock: ReturnType<typeof mockUpstreams>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe("shared entry path family", () => {
  it("accepts the shared destinations", () => {
    for (const path of [
      "/shared",
      "/shared/",
      `/shared/invitations/${SCOPE_ID}`,
      `/shared/chat/${SCOPE_ID}`,
      `/shared/terminal/${SCOPE_ID}`,
      `/shared/project/${SCOPE_ID}`,
      `/shared/file/${SCOPE_ID}`,
      `/shared/folder/${SCOPE_ID}`,
      `/shared/app/${SCOPE_ID}`,
      "/shared/organization",
      "/shared/organization-invitation",
      "/shared/a/b/c/d",
    ]) {
      expect(isSharedEntryPath(path), path).toBe(true);
    }
  });

  it("rejects adjacent and adversarial paths", () => {
    for (const path of [
      "",
      "/",
      "/sharedx",
      "/shared-with-me",
      "/SHARED",
      "/shared//chat",
      "/shared/chat//x",
      "/shared/chat/x/",
      "/shared/.",
      "/shared/..",
      "/shared/../billing",
      "/shared/%2e%2e",
      "/shared/chat%2Fx",
      "/shared/chat/a.b",
      "/shared\\chat",
      "/shared/chat/\u0000",
      "/shared/a/b/c/d/e",
      `/shared/${"a".repeat(129)}`,
      "/vm/member/shared",
      "/api/collaboration/shared",
      "/shared?billing=setup",
    ]) {
      expect(isSharedEntryPath(path), JSON.stringify(path)).toBe(false);
    }
    expect(isSharedEntryPath(`/shared/${"a".repeat(128)}`)).toBe(true);
  });

  it("qualifies only GET and HEAD document requests on the app domain", () => {
    expect(isSharedEntryDocumentRequest({ isAppDomain: true, method: "GET", path: "/shared" })).toBe(true);
    expect(isSharedEntryDocumentRequest({ isAppDomain: true, method: "HEAD", path: "/shared" })).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(isSharedEntryDocumentRequest({ isAppDomain: true, method, path: "/shared" })).toBe(false);
    }
    expect(isSharedEntryDocumentRequest({ isAppDomain: false, method: "GET", path: "/shared" })).toBe(false);
  });

  it("routes to the VPS only for a running, routable, entitled computer on this host", () => {
    const allowed = { runtimeProxyAllowed: true } as never;
    const denied = { runtimeProxyAllowed: false } as never;
    const machine = { ...runningMachine, provisioningClass: "customer", accessClerkUserIds: [] } as never;
    expect(resolveSharedEntryTarget({ host: "app.matrix-os.com", machine, entitlement: allowed })).toBe("vps");
    expect(resolveSharedEntryTarget({ host: "app.matrix-os.com", machine, entitlement: denied })).toBe("platform");
    expect(resolveSharedEntryTarget({ host: "app.matrix-os.com", machine: undefined, entitlement: allowed })).toBe("platform");
    expect(resolveSharedEntryTarget({
      host: "app.matrix-os.com",
      machine: { ...(machine as object), publicIPv4: null } as never,
      entitlement: allowed,
    })).toBe("platform");
    expect(resolveSharedEntryTarget({ host: "pr-12.preview.matrix-os.com", machine, entitlement: allowed })).toBe("platform");
  });
});

describe("shared entry routing", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    vi.restoreAllMocks();
    delete process.env.MATRIX_APP_DOMAIN_HOSTS;
  });

  it("serves the platform shell to a signed-in account without a computer", async () => {
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    for (const path of ["/shared", `/shared/chat/${SCOPE_ID}`, `/shared/invitations/${SCOPE_ID}`]) {
      fetchMock.mockClear();
      const res = await app.request(path, signedIn());
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain("platform frame");
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}${path}`]);
    }
  });

  it("serves HEAD requests for shared destinations from the platform shell", async () => {
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    const res = await app.request(`/shared/chat/${SCOPE_ID}`, { ...signedIn(), method: "HEAD" });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "HEAD" }));
  });

  it("serves the platform shell while the account's computer is provisioning", async () => {
    await insertUserMachine(db, { ...runningMachine, status: "provisioning", publicIPv4: null });
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    const res = await app.request(`/shared/chat/${SCOPE_ID}`, signedIn());

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("platform frame");
    expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}/shared/chat/${SCOPE_ID}`]);
  });

  it("serves the platform shell while the account's computer is stopped", async () => {
    await insertUserMachine(db, { ...runningMachine, status: "stopped" });
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    const res = await app.request(`/shared/project/${SCOPE_ID}`, signedIn());

    expect(res.status).toBe(200);
    expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}/shared/project/${SCOPE_ID}`]);
  });

  it("serves the platform shell instead of billing when the computer's entitlement blocks runtime access", async () => {
    await insertUserMachine(db, runningMachine);
    const fetchMock = mockUpstreams();
    const app = buildApp(db, { MATRIX_STRIPE_BILLING_ENABLED: "true" });

    const res = await app.request(`/shared/chat/${SCOPE_ID}`, signedIn());

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}/shared/chat/${SCOPE_ID}`]);

    fetchMock.mockClear();
    const home = await app.request("/", signedIn());
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/?billing=setup");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an account with a running entitled computer on its own VPS shell", async () => {
    await insertUserMachine(db, runningMachine);
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    const res = await app.request(`/shared/chat/${SCOPE_ID}`, signedIn());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("vps shell");
    expect(fetchTargets(fetchMock)).toEqual([`${VPS_ORIGIN}/shared/chat/${SCOPE_ID}`]);
    expect(res.headers.get("set-cookie") ?? "").toContain("matrix_shell_route=");
  });

  it("follows the selected computer slot for accounts with several computers", async () => {
    await insertUserMachine(db, runningMachine);
    await insertUserMachine(db, {
      ...runningMachine,
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff202",
      runtimeSlot: "staging",
      status: "provisioning",
      hetznerServerId: 123502,
      publicIPv4: null,
    });
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    const staging = await app.request(`/shared/chat/${SCOPE_ID}?runtime=staging`, signedIn());
    expect(staging.status).toBe(200);
    expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}/shared/chat/${SCOPE_ID}?runtime=staging`]);

    fetchMock.mockClear();
    const primary = await app.request(`/shared/chat/${SCOPE_ID}`, signedIn());
    expect(primary.status).toBe(200);
    expect(fetchTargets(fetchMock)).toEqual([`${VPS_ORIGIN}/shared/chat/${SCOPE_ID}`]);
  });

  it("serves the platform shell on a PR preview host without a matching computer", async () => {
    process.env.MATRIX_APP_DOMAIN_HOSTS = "pr-12.preview.matrix-os.com";
    await insertUserMachine(db, runningMachine);
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    const res = await app.request(`/shared/chat/${SCOPE_ID}`, signedIn("pr-12.preview.matrix-os.com"));

    expect(res.status).toBe(200);
    expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}/shared/chat/${SCOPE_ID}`]);

    fetchMock.mockClear();
    const home = await app.request("/", signedIn("pr-12.preview.matrix-os.com"));
    expect(home.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers a retryable 503 when the platform shell is unreachable, never billing", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    const app = buildApp(db);
    const path = `/shared/organization-invitation?__clerk_ticket=t%3C1&__clerk_status=sign_up`;

    const res = await app.request(path, signedIn());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('data-matrix-shared-entry-unavailable="true"');
    expect(html).toContain(
      'href="/shared/organization-invitation?__clerk_ticket=t%3C1&amp;__clerk_status=sign_up"',
    );
    expect(html).not.toContain("billing");
    expect(html).not.toContain("user_member");
    expect(html).not.toContain("<script");
  });

  it("keeps the signup billing handoff on the checkout path for accounts without a computer", async () => {
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    const res = await app.request("/?billing=setup&handoff=signup", signedIn());

    expect(res.status).toBe(200);
    expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}/?billing=setup&handoff=signup`]);
  });

  it("keeps non-shared documents on the existing billing fallback", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    const app = buildApp(db);

    const res = await app.request("/", signedIn());

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?billing=setup");
  });

  it("keeps explicit VM shared paths on the selected computer", async () => {
    await insertUserMachine(db, runningMachine);
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    const res = await app.request(`/vm/member/shared/chat/${SCOPE_ID}`, signedIn());

    expect(res.status).toBe(200);
    expect(fetchTargets(fetchMock)).toEqual([`${VPS_ORIGIN}/shared/chat/${SCOPE_ID}`]);
  });

  it("keeps explicit VM shared paths on billing recovery when the computer is not entitled", async () => {
    await insertUserMachine(db, runningMachine);
    const fetchMock = mockUpstreams();
    const app = buildApp(db, { MATRIX_STRIPE_BILLING_ENABLED: "true" });

    const res = await app.request(`/vm/member/shared/chat/${SCOPE_ID}`, signedIn());

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?billing=setup");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves signed-out shared destinations from the platform shell as before", async () => {
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    const res = await app.request(`/shared/chat/${SCOPE_ID}`, { headers: { host: "app.matrix-os.com" } });

    expect(res.status).toBe(200);
    expect(fetchTargets(fetchMock)).toEqual([`${AUTH_SHELL}/shared/chat/${SCOPE_ID}`]);
  });

  it("does not treat mutating requests to shared paths as platform documents", async () => {
    const fetchMock = mockUpstreams();
    const app = buildApp(db);

    const res = await app.request(`/shared/chat/${SCOPE_ID}`, { ...signedIn(), method: "POST" });

    expect(await res.text()).not.toContain("platform frame");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
