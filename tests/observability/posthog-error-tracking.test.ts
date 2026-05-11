import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  getPostHogClientConfig,
  resolvePostHogClientApiHost,
} from "../../packages/observability/src/client.ts";
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

  it("lets shell ignore relative PostHog API hosts that it cannot proxy", async () => {
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

    const shellClient = await readFile("shell/instrumentation-client.ts", "utf8");
    expect(shellClient).toContain("resolvePostHogClientApiHost");
    expect(shellClient).toContain("allowRelativeApiHost: false");
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

    const shellClient = await readFile("shell/instrumentation-client.ts", "utf8");
    expect(shellClient).toContain("Shell has no local PostHog /ingest proxy");
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
      expect(packageJson.scripts.build, file).toContain("@matrix-os/observability' build &&");
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
    const proxyCloseIndex = proxyMain.indexOf("server.close();");
    const proxyForcedExitIndex = proxyMain.indexOf("setTimeout(() => process.exit(0), 5_000).unref()");
    const proxyTelemetryDrainIndex = proxyMain.indexOf("await posthogErrorTracker.shutdown()");
    expect(proxyCloseIndex).toBeGreaterThanOrEqual(0);
    expect(proxyCloseIndex).toBeLessThan(proxyTelemetryDrainIndex);
    expect(proxyForcedExitIndex).toBeLessThan(proxyTelemetryDrainIndex);
    expect(proxyMain).toContain("setTimeout(() => process.exit(0), 5_000).unref()");
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
      expect(source, file).toContain("err instanceof HTTPException && err.status < 500");
      expect(source, file).toContain("void posthogErrorTracker.captureHonoException(err, c).catch");
    }
  });
});

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
