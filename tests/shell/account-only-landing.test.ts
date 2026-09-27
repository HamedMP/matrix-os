// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasAccountOnlySharedWork,
  shouldAttemptAccountOnlyLanding,
  useAccountOnlyLanding,
} from "../../shell/src/lib/account-only-landing.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function probeFetch(responses: { inbox?: unknown; shared?: unknown; organizations?: unknown; status?: number }) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const status = responses.status ?? 200;
    if (url.startsWith("/api/collaboration/inbox")) return jsonResponse(responses.inbox ?? { items: [] }, status);
    if (url.startsWith("/api/collaboration/shared")) return jsonResponse(responses.shared ?? { items: [] }, status);
    if (url === "/api/organizations") return jsonResponse(responses.organizations ?? { organizations: [] }, status);
    throw new Error(`unexpected ${url}`);
  });
}

const getToken = async () => "clerk-token";

describe("shouldAttemptAccountOnlyLanding", () => {
  const home = { pathname: "/", search: "" };

  it("lands only on the platform surface, in plan_required, at the app root", () => {
    expect(shouldAttemptAccountOnlyLanding({ platformSurface: true, phase: "plan_required", location: home })).toBe(true);
    expect(shouldAttemptAccountOnlyLanding({ platformSurface: false, phase: "plan_required", location: home })).toBe(false);
    for (const phase of ["payment_settling", "install_choices_required", "provisioning", "provisioning_failed", "first_run", "ready", "account_required", undefined] as const) {
      expect(shouldAttemptAccountOnlyLanding({ platformSurface: true, phase, location: home }), String(phase)).toBe(false);
    }
    expect(shouldAttemptAccountOnlyLanding({ platformSurface: true, phase: "plan_required", location: { pathname: "/runtime", search: "" } })).toBe(false);
  });

  it("never lands on billing entry points, signup handoff or device returns", () => {
    for (const search of [
      "?billing=setup",
      "?billing=setup&handoff=signup",
      "?billing=setup&handoff=add-computer",
      "?plans=1",
      "?checkout=success",
      "?device_return=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    ]) {
      expect(shouldAttemptAccountOnlyLanding({ platformSurface: true, phase: "plan_required", location: { pathname: "/", search } }), search).toBe(false);
    }
  });
});

describe("hasAccountOnlySharedWork", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds shared work from invitations, shares or organization membership", async () => {
    for (const responses of [
      { inbox: { items: [{ scopeId: "x" }] } },
      { shared: { items: [{ scopeId: "x" }] } },
      { organizations: { organizations: [{ organizationId: "org_1" }] } },
    ]) {
      await expect(hasAccountOnlySharedWork({ fetchImpl: probeFetch(responses), getToken })).resolves.toBe(true);
    }
  });

  it("stays on the plan screen when nothing is shared", async () => {
    const fetchImpl = probeFetch({});
    await expect(hasAccountOnlySharedWork({ fetchImpl, getToken })).resolves.toBe(false);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      "/api/collaboration/inbox?limit=1",
      "/api/collaboration/shared?limit=1",
      "/api/organizations",
    ]);
  });

  it("sends a bounded, authenticated same-origin request", async () => {
    const fetchImpl = probeFetch({});
    await hasAccountOnlySharedWork({ fetchImpl, getToken });
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.credentials).toBe("same-origin");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer clerk-token");
    }
  });

  it("treats failures, malformed bodies and timeouts as nothing shared", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(hasAccountOnlySharedWork({ fetchImpl: probeFetch({ status: 503 }), getToken })).resolves.toBe(false);
    await expect(hasAccountOnlySharedWork({
      fetchImpl: probeFetch({ inbox: { items: "nope" }, shared: [], organizations: { organizations: null } }),
      getToken,
    })).resolves.toBe(false);
    await expect(hasAccountOnlySharedWork({
      fetchImpl: vi.fn(async () => { throw new TypeError("fetch failed"); }),
      getToken,
    })).resolves.toBe(false);

    const hanging = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const started = Date.now();
    await expect(hasAccountOnlySharedWork({ fetchImpl: hanging, getToken, timeoutMs: 50 })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("bounds session token retrieval by the same deadline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = probeFetch({ shared: { items: [{ scopeId: "x" }] } });
    const started = Date.now();
    await expect(hasAccountOnlySharedWork({
      fetchImpl,
      getToken: () => new Promise<string | null>(() => undefined),
      timeoutMs: 50,
    })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still probes with the session cookie when no bearer is available", async () => {
    const fetchImpl = probeFetch({ shared: { items: [{ scopeId: "x" }] } });
    await expect(hasAccountOnlySharedWork({ fetchImpl, getToken: async () => null })).resolves.toBe(true);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull();
  });
});

describe("useAccountOnlyLanding", () => {
  const originalLocation = window.location;

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it("probes once per page load even when StrictMode replays the effect", async () => {
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, pathname: "/", search: "", replace },
    });
    const fetchImpl = probeFetch({ shared: { items: [{ scopeId: "x" }] } });
    vi.stubGlobal("fetch", fetchImpl);

    renderHook(() => useAccountOnlyLanding({ platformSurface: true, phase: "plan_required", getToken }), { wrapper: StrictMode });

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/shared"));
    expect(replace).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.filter((call) => String(call[0]).startsWith("/api/collaboration/shared"))).toHaveLength(1);
  });
});
