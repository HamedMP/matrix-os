import { PostHog } from "posthog-node";

/**
 * Anonymous CLI telemetry. Mirrors the env precedence of
 * `getPostHogConfig` in @matrix-os/observability, replicated here because
 * sync-client is published standalone to npm and cannot depend on the
 * private workspace package.
 *
 * No-op when no PostHog token is configured. Hard opt-out via
 * MATRIX_NO_TELEMETRY (any non-empty value). Never captures argument
 * values, paths, or any user content -- only command names and counts.
 */

type EnvSource = Record<string, string | undefined>;

const TOKEN_ENV_KEYS = [
  "POSTHOG_TOKEN",
  "POSTHOG_PROJECT_TOKEN",
  "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
  "NEXT_PUBLIC_POSTHOG_KEY",
];
const HOST_ENV_KEYS = ["POSTHOG_HOST", "NEXT_PUBLIC_POSTHOG_HOST"];

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

export const CLI_TELEMETRY_EVENTS = {
  COMMAND_RUN: "matrix_cli_command_run",
  LOGGED_IN: "matrix_cli_logged_in",
} as const;

export interface CliTelemetryConfig {
  token: string;
  host?: string;
}

export interface CliTelemetryCaptureInput {
  distinctId: string;
  event: string;
  properties: Record<string, string | number | boolean>;
}

export interface CliTelemetryClient {
  capture(input: CliTelemetryCaptureInput): void;
  shutdown(): Promise<unknown>;
}

export interface CliTelemetryLogger {
  warn(message: string): void;
}

export interface CreateCliTelemetryOptions {
  env?: EnvSource;
  clientFactory?: (config: CliTelemetryConfig) => CliTelemetryClient;
  logger?: CliTelemetryLogger;
  shutdownTimeoutMs?: number;
}

export interface CliTelemetry {
  enabled: boolean;
  captureCommandRun(command: string, argsCount: number): void;
  captureLoggedIn(): void;
  shutdown(): Promise<void>;
}

function firstEnv(env: EnvSource, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function errorKind(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

class TelemetryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`CLI telemetry shutdown timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TelemetryTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function resolveDistinctId(env: EnvSource): string {
  return env.MATRIX_USER_ID?.trim() || env.MATRIX_HANDLE?.trim() || "matrix-cli-anonymous";
}

export function createCliTelemetry(options: CreateCliTelemetryOptions = {}): CliTelemetry {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const shutdownTimeoutMs =
    typeof options.shutdownTimeoutMs === "number" &&
    Number.isFinite(options.shutdownTimeoutMs) &&
    options.shutdownTimeoutMs > 0
      ? options.shutdownTimeoutMs
      : DEFAULT_SHUTDOWN_TIMEOUT_MS;

  const optedOut = (env.MATRIX_NO_TELEMETRY ?? "").length > 0;
  const token = optedOut ? undefined : firstEnv(env, TOKEN_ENV_KEYS);
  const host = token ? firstEnv(env, HOST_ENV_KEYS) : undefined;
  const enabled = Boolean(token);
  const distinctId = resolveDistinctId(env);

  let client: CliTelemetryClient | null = null;

  function getClient(): CliTelemetryClient | null {
    if (!token) return null;
    if (!client) {
      const config: CliTelemetryConfig = host ? { token, host } : { token };
      client = options.clientFactory
        ? options.clientFactory(config)
        : new PostHog(config.token, {
            ...(config.host ? { host: config.host } : {}),
            // Short-lived process: send each event immediately, no batching,
            // no geo lookups.
            flushAt: 1,
            flushInterval: 0,
            disableGeoip: true,
          });
    }
    return client;
  }

  function capture(event: string, properties: Record<string, string | number | boolean>): void {
    try {
      const posthog = getClient();
      if (!posthog) return;
      posthog.capture({ distinctId, event, properties });
    } catch (err: unknown) {
      // Telemetry must never affect CLI behavior. Log the error kind only --
      // never the message, which could contain tokens or paths.
      logger.warn(`[telemetry] capture failed: ${errorKind(err)}`);
    }
  }

  return {
    enabled,
    captureCommandRun(command, argsCount) {
      capture(CLI_TELEMETRY_EVENTS.COMMAND_RUN, {
        command,
        args_count: argsCount,
      });
    },
    captureLoggedIn() {
      capture(CLI_TELEMETRY_EVENTS.LOGGED_IN, {});
    },
    async shutdown() {
      const posthog = client;
      if (!posthog) return;
      try {
        await withTimeout(Promise.resolve(posthog.shutdown()), shutdownTimeoutMs);
      } catch (err: unknown) {
        logger.warn(`[telemetry] shutdown failed: ${errorKind(err)}`);
      } finally {
        client = null;
      }
    },
  };
}

let sharedTelemetry: CliTelemetry | null = null;

/** Lazily created process-wide telemetry instance for CLI entrypoints. */
export function getCliTelemetry(): CliTelemetry {
  if (!sharedTelemetry) {
    sharedTelemetry = createCliTelemetry();
  }
  return sharedTelemetry;
}
