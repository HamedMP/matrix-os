import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOSTED_SHELL_SESSION_REFRESH_FALLBACK_MS,
  HOSTED_SHELL_SESSION_REFRESH_SKEW_MS,
  REQUIRED_COOKIES,
  computeHostedShellSessionRefreshDelay,
  handoffWithRetry,
  isStaleClerkCookie,
  parseSetCookieHeaders,
  performAppSessionHandoff,
  verifyCookiePair,
  type HandoffDeps,
  type ParsedCookie,
} from "@desktop/main/embeds/app-session";

const GATEWAY = "https://app.matrix-os.com";

type ScriptedResponse = { status: number; setCookieHeaders: string[] } | Error;

function scriptedDeps(
  script: ScriptedResponse[],
  jarCookies: Array<{ name: string; domain?: string; path?: string }> = [],
) {
  const requests: Array<{
    url: string;
    init: Parameters<HandoffDeps["request"]>[1];
  }> = [];
  const ops: string[] = [];
  const deps: HandoffDeps = {
    gatewayOrigin: GATEWAY,
    request: async (url, init) => {
      requests.push({ url, init });
      const next = script.shift();
      if (!next) throw new Error("unscripted request");
      if (next instanceof Error) throw next;
      return next;
    },
    cookieJar: {
      get: async () => {
        ops.push("jar:get");
        return jarCookies;
      },
      set: async (cookie) => {
        ops.push(`jar:set:${cookie.name}@${cookie.url}`);
      },
      remove: async (url, name) => {
        ops.push(`jar:remove:${name}@${url}`);
      },
    },
  };
  return { deps, requests, ops };
}

const BOTH_COOKIES: ScriptedResponse = {
  status: 200,
  setCookieHeaders: [
    "matrix_app_session=app-value; Path=/; HttpOnly; Secure; SameSite=Lax",
    "matrix_native_app_session=native-value; Path=/; Secure",
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseSetCookieHeaders", () => {
  it("parses multiple headers with attributes", () => {
    const cookies = parseSetCookieHeaders([
      "matrix_app_session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=.matrix-os.com",
      "matrix_native_app_session=def456; Path=/app; Secure",
    ]);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toEqual({
      name: "matrix_app_session",
      value: "abc123",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      domain: ".matrix-os.com",
    });
    expect(cookies[1]).toEqual({
      name: "matrix_native_app_session",
      value: "def456",
      path: "/app",
      secure: true,
    });
  });

  it("keeps comma-containing Expires values intact", () => {
    // Headers arrive pre-split as an array (Electron's net response gives
    // set-cookie as string[]), so the comma inside the Expires date never
    // requires splitting a combined header string.
    const expires = "Wed, 21 Oct 2026 07:28:00 GMT";
    const cookies = parseSetCookieHeaders([`matrix_app_session=abc; Expires=${expires}; Path=/`]);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.name).toBe("matrix_app_session");
    expect(cookies[0]?.expires).toBe(Date.parse(expires));
    expect(cookies[0]?.path).toBe("/");
  });

  it("treats attribute names case-insensitively", () => {
    const cookies = parseSetCookieHeaders([
      "x=y; PATH=/foo; HTTPONLY; secure; SAMESITE=STRICT; DOMAIN=.example.com",
    ]);
    expect(cookies[0]).toEqual({
      name: "x",
      value: "y",
      path: "/foo",
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      domain: ".example.com",
    });
  });

  it("keeps '=' characters inside cookie values", () => {
    const cookies = parseSetCookieHeaders(["tok=a=b=c; Path=/"]);
    expect(cookies[0]?.name).toBe("tok");
    expect(cookies[0]?.value).toBe("a=b=c");
  });

  it("maps SameSite=None to no_restriction and unknown values to unspecified", () => {
    const cookies = parseSetCookieHeaders(["a=1; SameSite=None", "b=2; SameSite=Bogus"]);
    expect(cookies[0]?.sameSite).toBe("no_restriction");
    expect(cookies[1]?.sameSite).toBe("unspecified");
  });

  it("derives expires from Max-Age relative to now", () => {
    const before = Date.now();
    const cookies = parseSetCookieHeaders(["a=1; Max-Age=3600"]);
    const after = Date.now();
    expect(cookies[0]?.expires).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(cookies[0]?.expires).toBeLessThanOrEqual(after + 3_600_000);
  });

  it("skips malformed headers with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSetCookieHeaders(["", "; Path=/", "=value"])).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("verifyCookiePair", () => {
  const pair: ParsedCookie[] = [
    { name: "matrix_app_session", value: "a" },
    { name: "matrix_native_app_session", value: "b" },
  ];

  it("requires both cookies (L2: single-cookie success bug)", () => {
    expect(verifyCookiePair(pair)).toBe(true);
    expect(verifyCookiePair([pair[0] as ParsedCookie])).toBe(false);
    expect(verifyCookiePair([pair[1] as ParsedCookie])).toBe(false);
    expect(verifyCookiePair([])).toBe(false);
  });

  it("rejects empty values", () => {
    expect(
      verifyCookiePair([
        { name: "matrix_app_session", value: "" },
        { name: "matrix_native_app_session", value: "b" },
      ]),
    ).toBe(false);
  });

  it("ignores unrelated cookies", () => {
    expect(verifyCookiePair([...pair, { name: "other", value: "x" }])).toBe(true);
  });

  it("exports the required cookie names", () => {
    expect(REQUIRED_COOKIES).toEqual(["matrix_app_session", "matrix_native_app_session"]);
  });
});

describe("isStaleClerkCookie", () => {
  it("flags __client and __session prefixed names (L3)", () => {
    expect(isStaleClerkCookie({ name: "__client" })).toBe(true);
    expect(isStaleClerkCookie({ name: "__client_uat" })).toBe(true);
    expect(isStaleClerkCookie({ name: "__session" })).toBe(true);
    expect(isStaleClerkCookie({ name: "__session_abc" })).toBe(true);
  });

  it("flags cookies on clerk domains regardless of name", () => {
    expect(isStaleClerkCookie({ name: "anything", domain: "clerk.matrix-os.com" })).toBe(true);
    expect(isStaleClerkCookie({ name: "anything", domain: ".Clerk.example.com" })).toBe(true);
  });

  it("leaves the matrix session cookies alone", () => {
    expect(isStaleClerkCookie({ name: "matrix_app_session", domain: "app.matrix-os.com" })).toBe(
      false,
    );
    expect(isStaleClerkCookie({ name: "matrix_native_app_session" })).toBe(false);
  });
});

describe("computeHostedShellSessionRefreshDelay", () => {
  it("schedules refresh ten minutes before the matrix app session expires", () => {
    const now = Date.parse("2026-06-25T10:00:00.000Z");
    const expires = now + 60 * 60 * 1000;
    expect(
      computeHostedShellSessionRefreshDelay([
        { name: "matrix_native_app_session", expires },
        { name: "matrix_app_session", expires },
      ], now),
    ).toBe(60 * 60 * 1000 - HOSTED_SHELL_SESSION_REFRESH_SKEW_MS);
  });

  it("refreshes immediately when the app session is already inside the skew window", () => {
    const now = Date.parse("2026-06-25T10:00:00.000Z");
    expect(
      computeHostedShellSessionRefreshDelay([
        { name: "matrix_app_session", expires: now + 2 * 60 * 1000 },
      ], now),
    ).toBe(0);
  });

  it("falls back to a periodic refresh when cookie expiry metadata is unavailable", () => {
    expect(
      computeHostedShellSessionRefreshDelay([
        { name: "matrix_app_session" },
        { name: "matrix_native_app_session", expires: Date.now() + 60_000 },
      ]),
    ).toBe(HOSTED_SHELL_SESSION_REFRESH_FALLBACK_MS);
  });
});

describe("performAppSessionHandoff", () => {
  it("posts redirectTo to the app-session endpoint", async () => {
    const { deps, requests } = scriptedDeps([BOTH_COOKIES]);
    await performAppSessionHandoff(deps, "/canvas");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${GATEWAY}/api/auth/app-session`);
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(requests[0]?.init.body ?? "{}")).toEqual({ redirectTo: "/canvas" });
  });

  it("returns auth on 401 and 403 without touching the jar", async () => {
    for (const status of [401, 403]) {
      const { deps, ops } = scriptedDeps([{ status, setCookieHeaders: [] }]);
      const result = await performAppSessionHandoff(deps, "/");
      expect(result).toEqual({ ok: false, reason: "auth" });
      expect(ops).toEqual([]);
    }
  });

  it("returns unavailable on other non-2xx statuses", async () => {
    const { deps } = scriptedDeps([{ status: 503, setCookieHeaders: [] }]);
    expect(await performAppSessionHandoff(deps, "/")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("returns unavailable on network failure without throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = scriptedDeps([new Error("ECONNREFUSED")]);
    expect(await performAppSessionHandoff(deps, "/")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("treats a single-cookie response as auth failure and installs nothing (L2)", async () => {
    const { deps, ops } = scriptedDeps([
      { status: 200, setCookieHeaders: ["matrix_app_session=only-one; Path=/"] },
    ]);
    const result = await performAppSessionHandoff(deps, "/");
    expect(result).toEqual({ ok: false, reason: "auth" });
    expect(ops.filter((op) => op.startsWith("jar:set"))).toEqual([]);
  });

  it("installs both cookies into the embed jar with the gateway url", async () => {
    const { deps, ops } = scriptedDeps([BOTH_COOKIES]);
    const result = await performAppSessionHandoff(deps, "/canvas");
    expect(result).toEqual({ ok: true });
    expect(ops.filter((op) => op.startsWith("jar:set"))).toEqual([
      `jar:set:matrix_app_session@${GATEWAY}`,
      `jar:set:matrix_native_app_session@${GATEWAY}`,
    ]);
  });

  it("removes stale Clerk cookies before installing (L3)", async () => {
    const { deps, ops } = scriptedDeps(
      [BOTH_COOKIES],
      [
        { name: "__client_uat", domain: "app.matrix-os.com" },
        { name: "harmless", domain: "app.matrix-os.com" },
        { name: "session_helper", domain: "clerk.matrix-os.com" },
      ],
    );
    const result = await performAppSessionHandoff(deps, "/");
    expect(result).toEqual({ ok: true });
    expect(ops.filter((op) => op.startsWith("jar:remove"))).toEqual([
      "jar:remove:__client_uat@https://app.matrix-os.com",
      "jar:remove:session_helper@https://clerk.matrix-os.com",
    ]);
    const lastRemove = ops.lastIndexOf("jar:remove:session_helper@https://clerk.matrix-os.com");
    const firstSet = ops.findIndex((op) => op.startsWith("jar:set"));
    expect(firstSet).toBeGreaterThan(lastRemove);
  });

  it("returns unavailable when cookie installation fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = scriptedDeps([BOTH_COOKIES]);
    deps.cookieJar.set = async () => {
      throw new Error("jar write failed");
    };
    expect(await performAppSessionHandoff(deps, "/")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("handoffWithRetry", () => {
  it("retries exactly once on unavailable", async () => {
    const { deps, requests } = scriptedDeps([{ status: 502, setCookieHeaders: [] }, BOTH_COOKIES]);
    const result = await handoffWithRetry(deps, "/canvas");
    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it("does not retry on auth failure (L1: never cascades)", async () => {
    const { deps, requests } = scriptedDeps([{ status: 401, setCookieHeaders: [] }]);
    const result = await handoffWithRetry(deps, "/canvas");
    expect(result).toEqual({ ok: false, reason: "auth" });
    expect(requests).toHaveLength(1);
  });

  it("gives up after the single retry", async () => {
    const { deps, requests } = scriptedDeps([
      { status: 500, setCookieHeaders: [] },
      { status: 500, setCookieHeaders: [] },
      BOTH_COOKIES,
    ]);
    const result = await handoffWithRetry(deps, "/canvas");
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(requests).toHaveLength(2);
  });

  it("never throws even when every request rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, requests } = scriptedDeps([new Error("boom"), new Error("boom")]);
    await expect(handoffWithRetry(deps, "/")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(requests).toHaveLength(2);
  });
});
