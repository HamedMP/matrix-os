import { describe, expect, it, vi } from "vitest";
import {
  CLI_TELEMETRY_EVENTS,
  createCliTelemetry,
  type CliTelemetryCaptureInput,
  type CliTelemetryClient,
} from "../../packages/sync-client/src/cli/telemetry.js";

interface FakeClientHandle {
  client: CliTelemetryClient;
  captured: CliTelemetryCaptureInput[];
  shutdownCalls: number;
}

function makeFakeClient(overrides: Partial<CliTelemetryClient> = {}): FakeClientHandle {
  const captured: CliTelemetryCaptureInput[] = [];
  const handle: FakeClientHandle = {
    captured,
    shutdownCalls: 0,
    client: {
      capture(input) {
        captured.push(input);
      },
      async shutdown() {
        handle.shutdownCalls += 1;
      },
      ...overrides,
    },
  };
  return handle;
}

const TOKEN_ENV = { POSTHOG_TOKEN: "phc_test_token" };

describe("CLI telemetry", () => {
  it("is a no-op when no PostHog token is configured", async () => {
    const factory = vi.fn();
    const telemetry = createCliTelemetry({ env: {}, clientFactory: factory });

    expect(telemetry.enabled).toBe(false);
    telemetry.captureCommandRun("sync", 2);
    telemetry.captureLoggedIn();
    await telemetry.shutdown();

    expect(factory).not.toHaveBeenCalled();
  });

  it("is hard-disabled when MATRIX_NO_TELEMETRY is set, even with a token", async () => {
    const factory = vi.fn();
    const telemetry = createCliTelemetry({
      env: { ...TOKEN_ENV, MATRIX_NO_TELEMETRY: "1" },
      clientFactory: factory,
    });

    expect(telemetry.enabled).toBe(false);
    telemetry.captureCommandRun("login", 0);
    await telemetry.shutdown();

    expect(factory).not.toHaveBeenCalled();
  });

  it("resolves token and host with the observability env precedence", () => {
    const factory = vi.fn((_config: { token: string; host?: string }) => makeFakeClient().client);
    const telemetry = createCliTelemetry({
      env: {
        POSTHOG_PROJECT_TOKEN: "phc_secondary",
        NEXT_PUBLIC_POSTHOG_KEY: "phc_last",
        NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com",
      },
      clientFactory: factory,
    });

    telemetry.captureCommandRun("status", 0);

    expect(factory).toHaveBeenCalledWith({
      token: "phc_secondary",
      host: "https://eu.i.posthog.com",
    });
  });

  it("captures matrix_cli_command_run with command name and args count only", () => {
    const handle = makeFakeClient();
    const telemetry = createCliTelemetry({
      env: { ...TOKEN_ENV, MATRIX_USER_ID: "user_42" },
      clientFactory: () => handle.client,
    });

    telemetry.captureCommandRun("sync", 3);

    expect(handle.captured).toHaveLength(1);
    const event = handle.captured[0];
    expect(event.event).toBe(CLI_TELEMETRY_EVENTS.COMMAND_RUN);
    expect(event.event).toBe("matrix_cli_command_run");
    expect(event.distinctId).toBe("user_42");
    expect(event.properties).toEqual({ command: "sync", args_count: 3 });
    // Never argument values or paths.
    expect(Object.keys(event.properties)).toEqual(["command", "args_count"]);
  });

  it("captures matrix_cli_logged_in on login success", () => {
    const handle = makeFakeClient();
    const telemetry = createCliTelemetry({
      env: TOKEN_ENV,
      clientFactory: () => handle.client,
    });

    telemetry.captureLoggedIn();

    expect(handle.captured).toHaveLength(1);
    expect(handle.captured[0].event).toBe("matrix_cli_logged_in");
  });

  it("falls back distinct_id from MATRIX_USER_ID to MATRIX_HANDLE to anonymous", () => {
    const cases: Array<{ env: Record<string, string>; expected: string }> = [
      { env: { MATRIX_USER_ID: "user_1", MATRIX_HANDLE: "alice" }, expected: "user_1" },
      { env: { MATRIX_HANDLE: "alice" }, expected: "alice" },
      { env: {}, expected: "matrix-cli-anonymous" },
    ];

    for (const { env, expected } of cases) {
      const handle = makeFakeClient();
      const telemetry = createCliTelemetry({
        env: { ...TOKEN_ENV, ...env },
        clientFactory: () => handle.client,
      });
      telemetry.captureCommandRun("whoami", 0);
      expect(handle.captured[0].distinctId).toBe(expected);
    }
  });

  it("swallows capture failures and warns with the error name only", () => {
    const warn = vi.fn();
    const telemetry = createCliTelemetry({
      env: TOKEN_ENV,
      clientFactory: () =>
        makeFakeClient({
          capture() {
            throw new TypeError("secret /home/alice/path leaked");
          },
        }).client,
      logger: { warn },
    });

    expect(() => telemetry.captureCommandRun("sync", 1)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain("TypeError");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("/home/alice");
  });

  it("bounds shutdown with a timeout so telemetry can never hang the CLI", async () => {
    const warn = vi.fn();
    const telemetry = createCliTelemetry({
      env: TOKEN_ENV,
      clientFactory: () =>
        makeFakeClient({
          shutdown: () => new Promise<void>(() => {}),
        }).client,
      logger: { warn },
      shutdownTimeoutMs: 50,
    });

    telemetry.captureCommandRun("sync", 0);

    const start = Date.now();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1_500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0] as string).toContain("TimeoutError");
  });

  it("logs nothing on successful shutdown and shuts the client down once", async () => {
    const warn = vi.fn();
    const handle = makeFakeClient();
    const telemetry = createCliTelemetry({
      env: TOKEN_ENV,
      clientFactory: () => handle.client,
      logger: { warn },
    });

    telemetry.captureCommandRun("sync", 0);
    await telemetry.shutdown();

    expect(handle.shutdownCalls).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("shutdown resolves without creating a client when nothing was captured", async () => {
    const factory = vi.fn();
    const telemetry = createCliTelemetry({ env: TOKEN_ENV, clientFactory: factory });

    await telemetry.shutdown();

    expect(factory).not.toHaveBeenCalled();
  });
});
