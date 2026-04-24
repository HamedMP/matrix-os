import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { deriveAppSessionKey, signAppSession, buildSetCookie, type AppSessionPayloadType } from "../../../packages/gateway/src/app-runtime/app-session.js";
import { appSessionMiddleware } from "../../../packages/gateway/src/app-runtime/app-session-middleware.js";

const MASTER_SECRET = "test-master-secret-for-unit-tests";

function createTestApp() {
  const app = new Hono();

  app.use(
    "/apps/:slug/*",
    appSessionMiddleware((slug) => deriveAppSessionKey(MASTER_SECRET, slug)),
  );

  app.get("/apps/:slug/*", (c) => {
    return c.json({ ok: true, slug: c.req.param("slug") });
  });

  return app;
}

function makeValidCookie(slug: string, overrides?: Partial<AppSessionPayloadType>): string {
  const key = deriveAppSessionKey(MASTER_SECRET, slug);
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: AppSessionPayloadType = {
    v: 1,
    slug,
    principal: "gateway-owner",
    scope: "personal",
    iat: nowSec,
    exp: nowSec + 600,
    ...overrides,
  };
  return signAppSession(key, payload);
}

describe("appSessionMiddleware", () => {
  it("401 without cookie + Accept: text/html returns HTML interstitial with postMessage script", async () => {
    const app = createTestApp();
    const res = await app.request("/apps/notes/index.html", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("matrix-os:session-expired");
    expect(body).toContain("window.parent.postMessage");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(res.headers.get("matrix-session-refresh")).toBe("/api/apps/notes/session");
  });

  it("401 without cookie + Accept: application/json returns JSON with Matrix-Session-Refresh header", async () => {
    const app = createTestApp();
    const res = await app.request("/apps/notes/api/data", {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("session_expired");
    expect(res.headers.get("matrix-session-refresh")).toBe("/api/apps/notes/session");
  });

  it("interstitial body is byte-identical across slugs", async () => {
    const app = createTestApp();
    const a = await (await app.request("/apps/notes/", { headers: { Accept: "text/html" } })).text();
    const b = await (await app.request("/apps/calendar/", { headers: { Accept: "text/html" } })).text();
    expect(a).toBe(b);
  });

  it("401 when cookie signed for another slug", async () => {
    const app = createTestApp();
    const cookieForCalendar = makeValidCookie("calendar");
    const res = await app.request("/apps/notes/", {
      headers: {
        Cookie: `matrix_app_session__notes=${cookieForCalendar}`,
        Accept: "text/html",
      },
    });
    expect(res.status).toBe(401);
  });

  it("401 when cookie expired", async () => {
    const app = createTestApp();
    const expiredCookie = makeValidCookie("notes", {
      exp: Math.floor(Date.now() / 1000) - 100,
    });
    const res = await app.request("/apps/notes/", {
      headers: {
        Cookie: `matrix_app_session__notes=${expiredCookie}`,
        Accept: "text/html",
      },
    });
    expect(res.status).toBe(401);
  });

  it("200 and passes through when cookie is valid", async () => {
    const app = createTestApp();
    const validCookie = makeValidCookie("notes");
    const res = await app.request("/apps/notes/", {
      headers: {
        Cookie: `matrix_app_session__notes=${validCookie}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.slug).toBe("notes");
  });

  it("401 HTML interstitial also includes Matrix-Session-Refresh header", async () => {
    const app = createTestApp();
    const res = await app.request("/apps/notes/", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("matrix-session-refresh")).toBe("/api/apps/notes/session");
  });

  it("cookie name embeds slug to isolate concurrent open apps", async () => {
    const app = createTestApp();
    const notesCookie = makeValidCookie("notes");
    const calendarCookie = makeValidCookie("calendar");

    // Notes cookie works for notes
    const res1 = await app.request("/apps/notes/", {
      headers: { Cookie: `matrix_app_session__notes=${notesCookie}` },
    });
    expect(res1.status).toBe(200);

    // Calendar cookie works for calendar
    const res2 = await app.request("/apps/calendar/", {
      headers: { Cookie: `matrix_app_session__calendar=${calendarCookie}` },
    });
    expect(res2.status).toBe(200);

    // Notes cookie does NOT work for calendar route
    const res3 = await app.request("/apps/calendar/", {
      headers: { Cookie: `matrix_app_session__notes=${notesCookie}` },
    });
    expect(res3.status).toBe(401);
  });
});
