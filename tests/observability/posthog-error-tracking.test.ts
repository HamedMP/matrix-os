import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  buildPostHogCookieConsentInitOptions,
  getPostHogClientConfig,
  getPostHogVisitorCountry,
  requiresPostHogCookieConsent,
  resolvePostHogClientApiHost,
} from "../../packages/observability/src/client.ts";
import {
  createPostHogErrorTracker,
  createPostHogServerExceptionReporter,
  extractPostHogDistinctId,
  installPostHogProcessErrorTracking,
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

  it("resolves relative PostHog API hosts for shells that proxy them", async () => {
    const relativeConfig = getPostHogClientConfig({
      NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
      NEXT_PUBLIC_POSTHOG_API_HOST: "/ingest",
      NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com",
    });
    const relativeConfigWithoutUiHost = getPostHogClientConfig({
      NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
      NEXT_PUBLIC_POSTHOG_API_HOST: "/ingest",
    });
    const absoluteConfig = getPostHogClientConfig({
      NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
      NEXT_PUBLIC_POSTHOG_API_HOST: "https://eu.i.posthog.com",
    });

    expect(relativeConfig).not.toBeNull();
    expect(relativeConfigWithoutUiHost).not.toBeNull();
    expect(absoluteConfig).not.toBeNull();
    expect(resolvePostHogClientApiHost(relativeConfig!)).toBe("/ingest");
    expect(resolvePostHogClientApiHost(relativeConfig!, { allowRelativeApiHost: false })).toBe(
      "https://eu.i.posthog.com",
    );
    expect(resolvePostHogClientApiHost(relativeConfigWithoutUiHost!, { allowRelativeApiHost: false })).toBeUndefined();
    expect(resolvePostHogClientApiHost(absoluteConfig!, { allowRelativeApiHost: false })).toBe(
      "https://eu.i.posthog.com",
    );

    const shellClient = await readFile("shell/src/lib/posthog-client.ts", "utf8");
    const wwwClient = await readFile("www/src/lib/posthog-client.ts", "utf8");
    const shellLayout = await readFile("shell/src/app/layout.tsx", "utf8");
    const wwwLayout = await readFile("www/src/app/layout.tsx", "utf8");
    expect(shellClient).toContain("resolvePostHogClientApiHost");
    // The shell ships a same-origin /relay rewrite, so it opts into relative
    // API hosts to keep capture calls first-party on user subdomains.
    expect(shellClient).toContain("allowRelativeApiHost: true");
    expect(shellClient).toContain("buildPostHogCookieConsentInitOptions");
    expect(wwwClient).toContain("buildPostHogCookieConsentInitOptions");
    expect(shellLayout).not.toContain("PostHogCookieBanner");
    expect(wwwLayout).toContain("PostHogCookieBanner");
  });

  it("extracts visitor country from deployment geolocation headers", () => {
    expect(
      getPostHogVisitorCountry(
        new Headers({
          "x-vercel-ip-country": "se",
        }),
      ),
    ).toBe("SE");
    expect(
      getPostHogVisitorCountry(
        new Headers({
          "cf-ipcountry": "DE",
        }),
      ),
    ).toBe("DE");
    expect(getPostHogVisitorCountry(new Headers({ "x-vercel-ip-country": "unknown" }))).toBeNull();
    expect(getPostHogVisitorCountry(new Headers({ "x-vercel-ip-country": "123" }))).toBeNull();
  });

  it("requires explicit PostHog cookie consent for European and unknown visitors", () => {
    expect(requiresPostHogCookieConsent("SE")).toBe(true);
    expect(requiresPostHogCookieConsent("de")).toBe(true);
    expect(requiresPostHogCookieConsent("NO")).toBe(true);
    expect(requiresPostHogCookieConsent("GB")).toBe(true);
    expect(requiresPostHogCookieConsent("CH")).toBe(true);
    expect(requiresPostHogCookieConsent("US")).toBe(false);
    expect(requiresPostHogCookieConsent(null)).toBe(true);
  });

  it("uses PostHog cookieless mode until explicit cookie consent is granted", () => {
    expect(buildPostHogCookieConsentInitOptions("SE")).toEqual({ cookieless_mode: "on_reject" });
    expect(buildPostHogCookieConsentInitOptions(null)).toEqual({ cookieless_mode: "on_reject" });
    expect(buildPostHogCookieConsentInitOptions("US")).toEqual({});
  });

  it("stays disabled when no PostHog token is configured", async () => {
    const tracker = createPostHogErrorTracker({
      env: {},
      service: "matrix-gateway",
    });

    expect(tracker.enabled).toBe(false);
    await expect(tracker.captureException(new Error("boom"))).resolves.toBe(false);
    await expect(tracker.captureEvent("host_bundle_release_registered")).resolves.toBe(false);
  });

  it("captures non-error PostHog events with sanitized properties", async () => {
    const capture = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    const tracker = createPostHogErrorTracker({
      env: {
        POSTHOG_TOKEN: "phc_test",
        POSTHOG_HOST: "https://eu.i.posthog.com",
      },
      service: "matrix-platform",
      clientFactory: () => ({
        capture,
        captureException: vi.fn(),
        flush,
        shutdown: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await expect(tracker.captureEvent("host_bundle_release_registered", {
      distinctId: "admin-1",
      properties: {
        version: "v2026.05.12-1",
        token: "secret".repeat(200),
      },
    })).resolves.toBe(true);

    expect(capture).toHaveBeenCalledWith({
      distinctId: "admin-1",
      event: "host_bundle_release_registered",
      properties: {
        service: "matrix-platform",
        version: "v2026.05.12-1",
        token: expect.stringMatching(/^secret/),
      },
    });
    expect(capture.mock.calls[0]?.[0].properties.token.length).toBeLessThanOrEqual(512);
    expect(flush).toHaveBeenCalledOnce();
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

  it("captures uncaught exceptions before exiting the process", async () => {
    const processEvents = new EventEmitter();
    const captureException = vi.fn().mockResolvedValue(true);
    const flush = vi.fn().mockResolvedValue(undefined);
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    installPostHogProcessErrorTracking({
      tracker: { enabled: true, captureException, flush, shutdown },
      process: processEvents,
      service: "matrix-gateway",
      logger: { warn: vi.fn(), error: vi.fn() },
      exit,
    });

    const err = new Error("background failure");
    processEvents.emit("uncaughtException", err, "uncaughtException");
    await new Promise((resolve) => setImmediate(resolve));

    expect(captureException).toHaveBeenCalledWith(err, {
      distinctId: undefined,
      properties: {
        service: "matrix-gateway",
        runtime: "node",
        error_source: "process",
        error_type: "uncaughtException",
      },
    });
    expect(flush).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits after uncaught exceptions even when the process logger fails", async () => {
    const processEvents = new EventEmitter();
    const captureException = vi.fn().mockResolvedValue(true);
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    installPostHogProcessErrorTracking({
      tracker: {
        enabled: true,
        captureException,
        flush: vi.fn().mockResolvedValue(undefined),
        shutdown,
      },
      process: processEvents,
      service: "matrix-gateway",
      logger: {
        warn: vi.fn(),
        error: vi.fn(() => {
          throw new Error("logger failed");
        }),
      },
      exit,
    });

    processEvents.emit("uncaughtException", new Error("background failure"), "uncaughtException");
    await new Promise((resolve) => setImmediate(resolve));

    expect(captureException).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("captures unhandled promise rejections without exiting the process", async () => {
    const processEvents = new EventEmitter();
    const captureException = vi.fn().mockResolvedValue(true);
    const exit = vi.fn();

    installPostHogProcessErrorTracking({
      tracker: {
        enabled: true,
        captureException,
        flush: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
      process: processEvents,
      service: "matrix-platform",
      logger: { warn: vi.fn(), error: vi.fn() },
      exit,
    });

    processEvents.emit("unhandledRejection", "async failure", Promise.resolve());
    await new Promise((resolve) => setImmediate(resolve));

    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      distinctId: undefined,
      properties: {
        service: "matrix-platform",
        runtime: "node",
        error_source: "process",
        error_type: "unhandledRejection",
      },
    });
    expect(captureException.mock.calls[0]?.[0].message).toBe("Non-Error rejection: async failure");
    expect(exit).not.toHaveBeenCalled();
  });

  it("captures object rejection values with diagnostic detail", async () => {
    const processEvents = new EventEmitter();
    const captureException = vi.fn().mockResolvedValue(true);
    const exit = vi.fn();

    installPostHogProcessErrorTracking({
      tracker: {
        enabled: true,
        captureException,
        flush: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
      process: processEvents,
      service: "matrix-platform",
      logger: { warn: vi.fn(), error: vi.fn() },
      exit,
    });

    processEvents.emit("unhandledRejection", { code: "worker_failed", retryable: true }, Promise.resolve());
    await new Promise((resolve) => setImmediate(resolve));

    expect(captureException.mock.calls[0]?.[0].message).toBe(
      'Non-Error rejection: {"code":"worker_failed","retryable":true}',
    );
    expect(exit).not.toHaveBeenCalled();
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

  it("preserves Hono-like HTTPExceptions from other module instances", async () => {
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

    app.get("/foreign-missing", () => {
      throw new ForeignHTTPException(404, "foreign missing");
    });
    app.get("/foreign-unavailable", () => {
      throw new ForeignHTTPException(503, "foreign unavailable");
    });

    const missing = await app.request("http://localhost/foreign-missing");
    const unavailable = await app.request("http://localhost/foreign-unavailable");

    expect(missing.status).toBe(404);
    await expect(missing.text()).resolves.toBe("foreign missing");
    expect(unavailable.status).toBe(503);
    await expect(unavailable.text()).resolves.toBe("foreign unavailable");
    expect(captureException).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
  });

  it("captures 5xx Hono HTTPExceptions while preserving their response", async () => {
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

    app.get("/unavailable", () => {
      throw new HTTPException(503, { message: "Service temporarily unavailable" });
    });

    const res = await app.request("http://localhost/unavailable");

    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toBe("Service temporarily unavailable");
    expect(captureException).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
  });

  it("logs fallback Hono errors when no custom error handler is provided", async () => {
    const logger = { warn: vi.fn() };
    const app = new Hono();

    installPostHogHonoErrorTracking(app, {
      env: {},
      service: "matrix-gateway",
      logger,
    });

    app.get("/boom", () => {
      throw new Error("boom");
    });

    const res = await app.request("http://localhost/boom");

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal Server Error" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Unhandled Hono exception"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
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
          path: "/dashboard?token=secret",
        },
        context: { routeType: "render" },
      }),
    ).resolves.toBe(true);

    expect(captureException).toHaveBeenCalledWith(error, "distinct-2", {
      service: "matrix-shell",
      runtime: "nextjs",
      method: "GET",
      path: "/dashboard",
      query_present: true,
      route_type: "render",
    });
    expect(JSON.stringify(captureException.mock.calls[0]?.[2])).not.toContain("secret");
    expect(flush).toHaveBeenCalledOnce();
  });

  it("uses explicit public env references in Next client PostHog entrypoints", async () => {
    const clientEntrypoints = [
      "shell/src/lib/posthog-client.ts",
      "www/src/lib/posthog-client.ts",
    ];

    for (const file of clientEntrypoints) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toContain("getPostHogClientConfig(process.env)");
      expect(source, file).not.toContain("...process.env");
      expect(source, file).not.toContain("as never");
      expect(source, file).toContain("process.env.NEXT_PUBLIC_POSTHOG_KEY");
    }

    const shellClient = await readFile("shell/instrumentation-client.ts", "utf8");
    expect(shellClient).toContain("initializeShellPostHog");

    const shellPostHogClient = await readFile("shell/src/lib/posthog-client.ts", "utf8");
    expect(shellPostHogClient).toContain("same-origin PostHog proxy at /relay");
    expect(shellPostHogClient).toContain('NEXT_PUBLIC_POSTHOG_API_HOST ?? "/relay"');
    expect(shellPostHogClient).toContain("buildPostHogCookieConsentInitOptions");
    expect(shellPostHogClient).not.toContain("__loaded");

    const wwwPostHogClient = await readFile("www/src/lib/posthog-client.ts", "utf8");
    expect(wwwPostHogClient).toContain("ensurePostHogInitialized(posthog, config)");
    expect(wwwPostHogClient).toContain("posthog.init(currentConfig.token");
    expect(wwwPostHogClient).toContain("buildPostHogCookieConsentInitOptions");
    expect(wwwPostHogClient).not.toContain("__loaded");
    expect(wwwPostHogClient).toContain('NEXT_PUBLIC_POSTHOG_API_HOST ?? "/relay"');

    const wwwClient = await readFile("www/instrumentation-client.ts", "utf8");
    expect(wwwClient).toContain("initializeWwwPostHog");
  });

  it("configures browser PostHog logs without console autocapture", async () => {
    const shellPostHogClient = await readFile("shell/src/lib/posthog-client.ts", "utf8");

    expect(shellPostHogClient).toContain("capturePostHogLog");
    expect(shellPostHogClient).toContain("posthog as PostHogWithLogger");
    expect(shellPostHogClient).toContain("serviceName: \"matrix-shell\"");
    expect(shellPostHogClient).toContain("captureConsoleLogs: false");
    expect(shellPostHogClient).not.toContain("captureConsoleLogs: true");
  });

  it("keeps the shell error preview dev-only and wired through the route error boundary", async () => {
    const [pageSource, crashSource] = await Promise.all([
      readFile("shell/src/app/__error-preview/page.tsx", "utf8"),
      readFile("shell/src/app/__error-preview/preview-crash.tsx", "utf8"),
    ]);

    expect(pageSource).toContain('process.env.NODE_ENV === "production"');
    expect(pageSource).toContain("notFound()");
    expect(crashSource).toContain('"use client"');
    expect(crashSource).toContain("Matrix OS error preview: verify PostHog error tracking");
  });

  it("captures shell error-boundary exceptions with copyable error IDs", async () => {
    const [routeError, globalError, errorUtils] = await Promise.all([
      readFile("shell/src/app/error.tsx", "utf8"),
      readFile("shell/src/app/global-error.tsx", "utf8"),
      readFile("shell/src/lib/error-boundary-utils.ts", "utf8"),
    ]);

    for (const source of [routeError, globalError]) {
      expect(source).toContain("capturePostHogException(error");
      expect(source).toContain("errorId");
      expect(source).toContain("Copy error ID");
      expect(source).toContain("createErrorId");
    }
    expect(errorUtils).toContain("crypto.randomUUID");
    expect(errorUtils).toContain("describeUnknownError");
  });

  it("tracks terminal websocket lifecycle without terminal output payloads", async () => {
    const [terminalPane, gatewayServer] = await Promise.all([
      readFile("shell/src/components/terminal/TerminalPane.tsx", "utf8"),
      readFile("packages/gateway/src/server.ts", "utf8"),
    ]);

    expect(terminalPane).toContain('capturePostHogEvent("shell_terminal_ws"');
    expect(terminalPane).toContain("capturePostHogLog");
    expect(terminalPane).toContain('track("schedule-reconnect"');
    expect(terminalPane).not.toContain("capturePostHogEvent(\"shell_terminal_ws\", { data");
    expect(gatewayServer).toContain('posthogErrorTracker.captureEvent("gateway_terminal_ws"');
    expect(gatewayServer).toContain('captureTerminalEvent("attach-request"');
    expect(gatewayServer).not.toContain('captureTerminalEvent("input"');
  });

  it("tracks billing provisioning decisions as metadata-only events", async () => {
    const billingPanel = await readFile(
      "shell/src/components/settings/sections/BillingPanel.tsx",
      "utf8",
    );

    expect(billingPanel).toContain('capturePostHogEvent("shell_billing"');
    expect(billingPanel).toContain("capturePostHogLog");
    expect(billingPanel).toContain('"view_provisioning_billing"');
    expect(billingPanel).toContain('"profile_select"');
    expect(billingPanel).toContain('"region_select"');
    expect(billingPanel).toContain('"checkout_intent"');
    expect(billingPanel).toContain('"checkout_stripe_available"');
    expect(billingPanel).toContain('"checkout_error"');
    expect(billingPanel).toContain("selected_hetzner_type");
    expect(billingPanel).toContain("selected_region_slug");
    expect(billingPanel).not.toContain("cardNumber");
    expect(billingPanel).not.toContain("terminalData");
  });

  it("tracks the landing to billing funnel before the shell handoff", async () => {
    const [landingPage, siteHeader, ctaPrimitives, landingTelemetry, landingBilling, wwwPostHogClient] = await Promise.all([
      readFile("www/src/app/page.tsx", "utf8"),
      readFile("www/src/components/landing/SiteHeader.tsx", "utf8"),
      readFile("www/src/components/landing/primitives.tsx", "utf8"),
      readFile("www/src/components/landing/LandingTelemetry.tsx", "utf8"),
      readFile("www/src/components/landing/LandingBilling.tsx", "utf8"),
      readFile("www/src/lib/posthog-client.ts", "utf8"),
    ]);

    expect(wwwPostHogClient).toContain("capturePostHogEvent");
    expect(landingPage).toContain("<LandingTelemetry />");
    expect(landingPage).toContain("<SiteHeader />");
    expect(siteHeader).toContain('data-ph-event="marketing_cta_clicked"');
    expect(ctaPrimitives).toContain('"data-ph-event": "marketing_cta_clicked"');
    expect(landingTelemetry).toContain("MATRIX_TELEMETRY_EVENTS.MARKETING_LANDING_VIEWED");
    expect(landingTelemetry).toContain("MATRIX_TELEMETRY_EVENTS.MARKETING_SIGNUP_CLICKED");
    expect(landingTelemetry).toContain("[data-ph-event]");
    expect(landingBilling).toContain("MATRIX_TELEMETRY_EVENTS.MARKETING_BILLING_VIEWED");
    expect(landingBilling).toContain("MATRIX_TELEMETRY_EVENTS.MARKETING_BILLING_PLAN_CLICKED");
    expect(landingBilling).toContain('"marketing_billing_cta_clicked"');
    expect(landingBilling).toContain('"stripe_static_plans"');
  });

  it("tracks shell, gateway, and CLI/TUI product activity without content payloads", async () => {
    const [billingGate, gatewayServer, platformAuthRoutes, platformMain] = await Promise.all([
      readFile("shell/src/components/BillingGate.tsx", "utf8"),
      readFile("packages/gateway/src/server.ts", "utf8"),
      readFile("packages/platform/src/auth-routes.ts", "utf8"),
      readFile("packages/platform/src/main.ts", "utf8"),
    ]);

    expect(billingGate).toContain('"shell_access_state_changed"');
    expect(billingGate).toContain('"billing_checkout_confirmed"');
    expect(gatewayServer).toContain('captureEvent("gateway_product"');
    expect(gatewayServer).toContain('"shell_ws_open"');
    expect(gatewayServer).toContain('"agent_task_started"');
    expect(gatewayServer).toContain('"agent_task_completed"');
    expect(gatewayServer).toContain('"sync_peer_subscribe"');
    expect(platformAuthRoutes).toContain('"cli_device_code_created"');
    expect(platformAuthRoutes).toContain('"cli_device_token_issued"');
    expect(platformAuthRoutes).toContain('"cli_runtime_lookup_resolved"');
    expect(platformMain).toContain("MATRIX_TELEMETRY_EVENTS.CLI_COMMAND_RUN");
    expect(platformMain).toContain("auth_event: event");
    expect(gatewayServer).not.toContain('captureGatewayProductEvent("terminal_input"');
    expect(gatewayServer).not.toContain('captureGatewayProductEvent("message_text"');
  });

  it("queues Next server PostHog reporting off the request-error hook path", async () => {
    const serverEntrypoints = [
      "shell/instrumentation.ts",
      "www/instrumentation.ts",
    ];

    for (const file of serverEntrypoints) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toContain("await reporter.captureException");
      expect(source, file).not.toContain("await postHogServerErrorReporter.captureException");
      expect(source, file).toContain("void ");
      expect(source, file).toContain(".captureException(err, { request, context }).catch");
      expect(source, file).toContain("console.warn");
    }
  });

  it("exposes shutdown hooks for Next server reporters", async () => {
    const [shellSource, wwwSource] = await Promise.all([
      readFile("shell/instrumentation.ts", "utf8"),
      readFile("www/instrumentation.ts", "utf8"),
    ]);

    expect(shellSource).toContain("export const shellPostHogReporter");
    expect(shellSource).toContain("export async function unregister()");
    expect(shellSource).toContain("await shellPostHogReporter.shutdown()");
    expect(wwwSource).toContain("export async function unregister()");
    expect(wwwSource).toContain("await shutdownPostHog()");
  });

  it("documents PostHog SDK timeout and warm-process shutdown behavior", async () => {
    const [observabilitySource, wwwServer] = await Promise.all([
      readFile("packages/observability/src/index.ts", "utf8"),
      readFile("www/src/lib/posthog-server.ts", "utf8"),
    ]);

    expect(observabilitySource).toContain("PostHog SDK does not expose an AbortSignal");
    expect(observabilitySource).toContain("bounds only the await");
    expect(wwwServer).toContain("shutdownPostHog is also used as an action-level flush");
    expect(wwwServer).toContain("allow later warm-process calls to recreate clients");
  });

  it("does not pass PostHog secrets to external Conduit containers", async () => {
    const composeFiles = [
      "docker-compose.dev.yml",
      "distro/docker-compose.platform.yml",
    ];

    for (const file of composeFiles) {
      const source = await readFile(file, "utf8");
      const conduitBlock = readYamlServiceBlock(source, "conduit");
      expect(conduitBlock, file).not.toContain("POSTHOG_TOKEN");
      expect(conduitBlock, file).not.toContain("POSTHOG_HOST");
    }
  });

  it("preserves the public PostHog project-token alias in shell build paths", async () => {
    const shellBuildConfigFiles = [
      "Dockerfile",
      "scripts/build-user-image.sh",
      "scripts/build-host-bundle.sh",
      "docker-compose.yml",
      "docker-compose.branch.yml",
      "docker-compose.dev-vps.yml",
      "docker-compose.dev.yml",
      "docker-compose.staging.yml",
      "distro/docker-compose.local.yml",
      "distro/docker-compose.multi.yml",
      "distro/docker-compose.platform.yml",
    ];

    for (const file of shellBuildConfigFiles) {
      const source = await readFile(file, "utf8");
      expect(source, file).toContain("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN");
      expect(countOccurrences(source, "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN"), file).toBe(
        countOccurrences(source, "NEXT_PUBLIC_POSTHOG_KEY"),
      );
    }
  });

  it("allows only explicit public PostHog telemetry aliases to provisioned containers", async () => {
    const platformStartupEnv = await readFile("packages/platform/src/platform-startup-env.ts", "utf8");

    expect(platformStartupEnv).toContain("TENANT_PUBLIC_TELEMETRY_ENV_KEYS");
    expect(platformStartupEnv).toContain("'POSTHOG_TOKEN'");
    expect(platformStartupEnv).toContain("'POSTHOG_PROJECT_TOKEN'");
    expect(platformStartupEnv).not.toContain("'CLERK_SECRET_KEY'");
  });

  it("bakes public PostHog env into full-image compose shell builds", async () => {
    const composeShellServices = [
      { file: "distro/docker-compose.local.yml", services: ["alice", "bob"] },
      { file: "distro/docker-compose.multi.yml", services: ["matrixos"] },
    ];
    const publicEnvKeys = [
      "NEXT_PUBLIC_POSTHOG_KEY",
      "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
      "NEXT_PUBLIC_POSTHOG_HOST",
      "NEXT_PUBLIC_POSTHOG_API_HOST",
    ];

    for (const { file, services } of composeShellServices) {
      const source = await readFile(file, "utf8");
      for (const service of services) {
        const block = readYamlServiceBlock(source, service);
        expect(block, `${file}:${service}`).toContain("args:");
        for (const key of publicEnvKeys) {
          expect(block, `${file}:${service}`).toContain(`${key}: \${${key}:-}`);
        }
      }
    }
  });

  it("publishes observability through built export conditions", async () => {
    const packageJson = JSON.parse(await readFile("packages/observability/package.json", "utf8")) as {
      exports: Record<string, { types: string; import: string; default: string }>;
    };

    expect(packageJson.exports["."]).toEqual({
      types: "./src/index.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    });
    expect(packageJson.exports["./client"]).toEqual({
      types: "./src/client.ts",
      import: "./dist/client.js",
      default: "./dist/client.js",
    });
  });

  it("builds observability before package consumers that import it", async () => {
    const consumerPackages = [
      "packages/gateway/package.json",
      "packages/platform/package.json",
      "packages/proxy/package.json",
      "shell/package.json",
      "www/package.json",
    ];

    for (const file of consumerPackages) {
      const packageJson = JSON.parse(await readFile(file, "utf8")) as { scripts: Record<string, string> };
      const buildScript = packageJson.scripts.build;
      const observabilityBuildIndex = buildScript.indexOf("--filter '@matrix-os/observability'");
      const consumerBuildIndex = buildScript.indexOf("&&");
      expect(observabilityBuildIndex, file).toBeGreaterThanOrEqual(0);
      expect(consumerBuildIndex, file).toBeGreaterThan(observabilityBuildIndex);
    }

    const rootPackage = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(rootPackage.scripts["typecheck:build-kernel"]).toContain(
      "pnpm --filter '@matrix-os/observability' build",
    );
    await expect(readFile("Dockerfile", "utf8")).resolves.toContain(
      "pnpm --filter '@matrix-os/observability' build",
    );
    await expect(readFile("scripts/build-host-bundle.sh", "utf8")).resolves.toContain(
      "pnpm --filter '@matrix-os/observability' build",
    );
    const devEntrypoint = await readFile("distro/docker-dev-entrypoint.sh", "utf8");
    expect(devEntrypoint).toContain("pnpm --filter @matrix-os/observability build");
    expect(devEntrypoint).toContain("mkdir -p /app/packages/observability/dist");
    expect(devEntrypoint).toContain("chown -R matrixos:matrixos /app/packages/observability/dist");
  });

  it("wires shutdown for PostHog clients outside top-level Hono apps", async () => {
    const [gatewaySocial, gatewayServer, platformSocialApi, platformMain, platformStartup, proxyMain, wwwServer] = await Promise.all([
      readFile("packages/gateway/src/social.ts", "utf8"),
      readFile("packages/gateway/src/server.ts", "utf8"),
      readFile("packages/platform/src/social-api.ts", "utf8"),
      readFile("packages/platform/src/main.ts", "utf8"),
      readFile("packages/platform/src/platform-startup.ts", "utf8"),
      readFile("packages/proxy/src/main.ts", "utf8"),
      readFile("www/src/lib/posthog-server.ts", "utf8"),
    ]);

    expect(gatewaySocial).toContain("shutdownPostHog");
    expect(gatewayServer).toContain("await socialRoutes?.shutdownPostHog()");
    expect(platformSocialApi).toContain("shutdownPostHog");
    expect(platformStartup).toContain("await app.shutdownPostHog()");
    expect(platformMain).toContain("await Promise.allSettled(posthogShutdowns.map((shutdownPostHog) => shutdownPostHog()))");
    expect(platformMain).not.toContain("for (let i = posthogShutdowns.length - 1");
    expect(proxyMain).toContain("await posthogErrorTracker.shutdown()");
    const proxyCloseIndex = proxyMain.indexOf("server.close();");
    const proxyForcedExitIndex = proxyMain.indexOf("const forceExit = setTimeout(() => process.exit(1), 6_000)");
    const proxyTelemetryDrainIndex = proxyMain.indexOf("await posthogErrorTracker.shutdown()");
    expect(proxyCloseIndex).toBeGreaterThanOrEqual(0);
    expect(proxyCloseIndex).toBeLessThan(proxyTelemetryDrainIndex);
    expect(proxyForcedExitIndex).toBeLessThan(proxyTelemetryDrainIndex);
    expect(proxyMain).not.toContain(".unref()");
    expect(proxyMain).toContain("clearTimeout(forceExit)");
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
      expect(source, file).toContain("isHonoHTTPExceptionLike(err)");
      expect(source, file).toContain("return err.getResponse()");
      expect(source, file).toContain("void posthogErrorTracker.captureHonoException(err, c).catch");
    }
  });
});

class ForeignHTTPException extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HTTPException";
  }

  getResponse(): Response {
    return new Response(this.message, { status: this.status });
  }
}

function readYamlServiceBlock(source: string, serviceName: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  if (start === -1) return "";
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("  ") && !line.startsWith("    ") && line.trim().endsWith(":")) {
      break;
    }
    block.push(line);
  }
  return block.join("\n");
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}
