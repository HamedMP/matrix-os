import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getPostHogClientConfig } from "../../packages/observability/src/client.ts";
import {
  createPostHogErrorTracker,
  createPostHogServerExceptionReporter,
  extractPostHogDistinctId,
  installPostHogHonoErrorTracking,
} from "../../packages/observability/src/index.ts";

describe("PostHog error tracking", () => {
  it("resolves client-side PostHog config from public env aliases", () => {
    expect(
      getPostHogClientConfig({
        NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
        NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com",
        NEXT_PUBLIC_POSTHOG_API_HOST: "/ingest",
      }),
    ).toEqual({
      token: "phc_test",
      apiHost: "/ingest",
      uiHost: "https://eu.i.posthog.com",
    });
    expect(getPostHogClientConfig({})).toBeNull();
  });

  it("stays disabled when no PostHog token is configured", async () => {
    const tracker = createPostHogErrorTracker({
      env: {},
      service: "matrix-gateway",
    });

    expect(tracker.enabled).toBe(false);
    await expect(tracker.captureException(new Error("boom"))).resolves.toBe(false);
  });

  it("captures Hono errors with sanitized request properties", async () => {
    const captureException = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    const app = new Hono();

    installPostHogHonoErrorTracking(app, {
      env: {
        POSTHOG_TOKEN: "phc_test",
        POSTHOG_HOST: "https://eu.i.posthog.com",
      },
      service: "matrix-gateway",
      clientFactory: () => ({
        captureException,
        flush,
        shutdown: vi.fn().mockResolvedValue(undefined),
      }),
    });

    app.get("/boom", () => {
      throw new Error("boom");
    });

    const res = await app.request("http://localhost/boom?token=secret", {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "user-agent": "vitest",
        "x-matrix-user": "user-1",
      },
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal Server Error" });
    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException.mock.calls[0]?.[1]).toBe("user-1");
    expect(captureException.mock.calls[0]?.[2]).toMatchObject({
      service: "matrix-gateway",
      runtime: "hono",
      method: "GET",
      path: "/boom",
      query_present: true,
      user_agent: "vitest",
    });
    expect(JSON.stringify(captureException.mock.calls[0]?.[2])).not.toContain("secret");
    expect(flush).toHaveBeenCalledOnce();
  });

  it("extracts a PostHog distinct id from the browser cookie", () => {
    const encoded = encodeURIComponent(JSON.stringify({ distinct_id: "distinct-1" }));

    expect(extractPostHogDistinctId(`ph_phc_test_posthog=${encoded}; other=1`)).toBe("distinct-1");
    expect(extractPostHogDistinctId("ph_phc_test_posthog=not-json")).toBeUndefined();
  });

  it("captures Next.js server request errors with cookie distinct id", async () => {
    const captureException = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    const reporter = createPostHogServerExceptionReporter({
      env: {
        POSTHOG_TOKEN: "phc_test",
        POSTHOG_HOST: "https://eu.i.posthog.com",
      },
      service: "matrix-shell",
      clientFactory: () => ({
        captureException,
        flush,
        shutdown: vi.fn().mockResolvedValue(undefined),
      }),
    });
    const error = new Error("render failed");
    const cookie = `ph_phc_test_posthog=${encodeURIComponent(
      JSON.stringify({ distinct_id: "distinct-2" }),
    )}`;

    await expect(
      reporter.captureException(error, {
        request: {
          headers: { cookie },
          method: "GET",
          path: "/dashboard",
        },
        context: { routeType: "render" },
      }),
    ).resolves.toBe(true);

    expect(captureException).toHaveBeenCalledWith(error, "distinct-2", {
      service: "matrix-shell",
      runtime: "nextjs",
      method: "GET",
      path: "/dashboard",
      route_type: "render",
    });
    expect(flush).toHaveBeenCalledOnce();
  });
});
