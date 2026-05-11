import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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

  it("does not capture expected 4xx Hono HTTPExceptions", async () => {
    const captureException = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    const app = new Hono();

    installPostHogHonoErrorTracking(app, {
      env: { POSTHOG_TOKEN: "phc_test" },
      service: "matrix-gateway",
      clientFactory: () => ({
        captureException,
        flush,
        shutdown: vi.fn().mockResolvedValue(undefined),
      }),
    });

    app.get("/missing", () => {
      throw new HTTPException(404, { message: "missing" });
    });

    const res = await app.request("http://localhost/missing");

    expect(res.status).toBe(404);
    expect(captureException).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("returns Hono 500 responses without waiting for telemetry flush", async () => {
    vi.useFakeTimers();
    try {
      const captureException = vi.fn();
      const flush = vi.fn(() => new Promise<void>(() => undefined));
      const app = new Hono();

      installPostHogHonoErrorTracking(app, {
        env: { POSTHOG_TOKEN: "phc_test" },
        service: "matrix-gateway",
        flushTimeoutMs: 5,
        clientFactory: () => ({
          captureException,
          flush,
          shutdown: vi.fn().mockResolvedValue(undefined),
        }),
      });

      app.get("/boom", () => {
        throw new Error("boom");
      });

      const res = await app.request("http://localhost/boom");

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "Internal Server Error" });
      expect(captureException).toHaveBeenCalledOnce();
      expect(flush).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait indefinitely when a PostHog flush hangs", async () => {
    vi.useFakeTimers();
    try {
      const captureException = vi.fn();
      const flush = vi.fn(() => new Promise<void>(() => undefined));
      const logger = { warn: vi.fn() };
      const tracker = createPostHogErrorTracker({
        env: { POSTHOG_TOKEN: "phc_test" },
        service: "matrix-gateway",
        flushTimeoutMs: 25,
        logger,
        clientFactory: () => ({
          captureException,
          flush,
          shutdown: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const result = tracker.captureException(new Error("boom"));
      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toBe(false);
      expect(captureException).toHaveBeenCalledOnce();
      expect(flush).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("TimeoutError"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create a PostHog client during shutdown and recreates after shutdown", async () => {
    const captureException = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const clientFactory = vi.fn(() => ({
      captureException,
      flush,
      shutdown,
    }));
    const tracker = createPostHogErrorTracker({
      env: { POSTHOG_TOKEN: "phc_test" },
      service: "matrix-www",
      clientFactory,
    });

    await tracker.shutdown();

    expect(clientFactory).not.toHaveBeenCalled();

    await expect(tracker.captureException(new Error("first"))).resolves.toBe(true);
    await tracker.shutdown();
    await expect(tracker.captureException(new Error("second"))).resolves.toBe(true);

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledTimes(2);
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

  it("uses explicit public env references in Next client PostHog entrypoints", async () => {
    const clientEntrypoints = [
      "shell/instrumentation-client.ts",
      "shell/src/lib/posthog-client.ts",
      "www/instrumentation-client.ts",
      "www/src/lib/posthog-client.ts",
    ];

    for (const file of clientEntrypoints) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toContain("getPostHogClientConfig(process.env)");
      expect(source, file).not.toContain("...process.env");
      expect(source, file).not.toContain("as never");
      expect(source, file).toContain("process.env.NEXT_PUBLIC_POSTHOG_KEY");
    }
  });

  it("wires shutdown for PostHog clients outside top-level Hono apps", async () => {
    const [gatewaySocial, gatewayServer, platformSocialApi, platformMain, proxyMain, wwwServer] = await Promise.all([
      readFile("packages/gateway/src/social.ts", "utf8"),
      readFile("packages/gateway/src/server.ts", "utf8"),
      readFile("packages/platform/src/social-api.ts", "utf8"),
      readFile("packages/platform/src/main.ts", "utf8"),
      readFile("packages/proxy/src/main.ts", "utf8"),
      readFile("www/src/lib/posthog-server.ts", "utf8"),
    ]);

    expect(gatewaySocial).toContain("shutdownPostHog");
    expect(gatewayServer).toContain("await socialRoutes?.shutdownPostHog()");
    expect(platformSocialApi).toContain("shutdownPostHog");
    expect(platformMain).toContain("await app.shutdownPostHog()");
    expect(proxyMain).toContain("await posthogErrorTracker.shutdown()");
    expect(wwwServer).toContain("await postHogServerErrorReporter.shutdown()");
  });

  it("queues social route PostHog capture off the error response path", async () => {
    const socialRouteFiles = [
      "packages/gateway/src/social.ts",
      "packages/platform/src/social-api.ts",
    ];

    for (const file of socialRouteFiles) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toContain("await posthogErrorTracker.captureHonoException");
      expect(source, file).toContain("void posthogErrorTracker.captureHonoException(err, c).catch");
    }
  });
});
