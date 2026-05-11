import { PostHog } from "posthog-node";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

type EnvSource = Record<string, string | undefined>;
type PrimitiveProperty = string | number | boolean;
type PostHogProperties = Record<string, PrimitiveProperty | null | undefined>;

export type PostHogCaptureClient = Pick<PostHog, "captureException" | "flush" | "shutdown">;

export interface PostHogConfig {
  token: string;
  host?: string;
}

export interface PostHogLogger {
  warn(message: string): void;
}

export interface CreatePostHogErrorTrackerOptions {
  env?: EnvSource;
  service: string;
  clientFactory?: (config: PostHogConfig) => PostHogCaptureClient;
  logger?: PostHogLogger;
}

export interface CaptureExceptionOptions {
  distinctId?: string;
  properties?: PostHogProperties;
}

export interface PostHogErrorTracker {
  enabled: boolean;
  captureException(error: unknown, options?: CaptureExceptionOptions): Promise<boolean>;
  captureHonoException(error: unknown, c: Context, properties?: PostHogProperties): Promise<boolean>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface InstallPostHogHonoErrorTrackingOptions extends CreatePostHogErrorTrackerOptions {
  clientErrorMessage?: string;
  onError?: (err: Error, c: Context) => Response | Promise<Response>;
}

export interface NextRequestLike {
  headers?: Headers | Record<string, string | string[] | undefined> | { get(name: string): string | null };
  method?: string;
  path?: string;
  url?: string;
}

export interface NextRequestErrorContextLike {
  routeType?: string;
  routePath?: string;
  routerKind?: string;
}

export interface NextServerExceptionInput {
  request?: NextRequestLike;
  context?: NextRequestErrorContextLike;
  distinctId?: string;
  properties?: PostHogProperties;
}

export interface PostHogServerExceptionReporter {
  enabled: boolean;
  captureException(error: unknown, input?: NextServerExceptionInput): Promise<boolean>;
  shutdown(): Promise<void>;
}

const TOKEN_ENV_KEYS = [
  "POSTHOG_TOKEN",
  "POSTHOG_PROJECT_TOKEN",
  "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
  "NEXT_PUBLIC_POSTHOG_KEY",
];
const HOST_ENV_KEYS = ["POSTHOG_HOST", "NEXT_PUBLIC_POSTHOG_HOST"];
const DEFAULT_CLIENT_ERROR_MESSAGE = "Internal Server Error";
const MAX_PROPERTY_LENGTH = 512;

export function getPostHogConfig(env: EnvSource = process.env): PostHogConfig | null {
  const token = firstEnv(env, TOKEN_ENV_KEYS);
  if (!token) return null;
  const host = firstEnv(env, HOST_ENV_KEYS);
  return host ? { token, host } : { token };
}

export function createPostHogErrorTracker(
  options: CreatePostHogErrorTrackerOptions,
): PostHogErrorTracker {
  const logger = options.logger ?? console;
  const config = getPostHogConfig(options.env);
  let client: PostHogCaptureClient | null = null;

  function getClient(): PostHogCaptureClient | null {
    if (!config) return null;
    if (!client) {
      client = options.clientFactory
        ? options.clientFactory(config)
        : new PostHog(config.token, {
            ...(config.host ? { host: config.host } : {}),
            flushAt: 1,
            flushInterval: 0,
          });
    }
    return client;
  }

  async function captureException(
    error: unknown,
    captureOptions: CaptureExceptionOptions = {},
  ): Promise<boolean> {
    const posthog = getClient();
    if (!posthog) return false;

    try {
      posthog.captureException(
        error,
        sanitizeDistinctId(captureOptions.distinctId),
        sanitizeProperties({
          service: options.service,
          ...captureOptions.properties,
        }),
      );
      await posthog.flush();
      return true;
    } catch (err: unknown) {
      logger.warn(`[posthog] Failed to capture exception for ${options.service}: ${errorKind(err)}`);
      return false;
    }
  }

  return {
    enabled: Boolean(config),
    captureException,
    captureHonoException(error, c, properties) {
      return captureException(error, {
        distinctId: getHonoDistinctId(c),
        properties: {
          ...buildHonoProperties(options.service, c),
          ...properties,
        },
      });
    },
    async flush() {
      const posthog = getClient();
      if (!posthog) return;
      try {
        await posthog.flush();
      } catch (err: unknown) {
        logger.warn(`[posthog] Failed to flush events for ${options.service}: ${errorKind(err)}`);
      }
    },
    async shutdown() {
      const posthog = getClient();
      if (!posthog) return;
      try {
        await posthog.shutdown();
      } catch (err: unknown) {
        logger.warn(`[posthog] Failed to shut down client for ${options.service}: ${errorKind(err)}`);
      }
    },
  };
}

export function installPostHogHonoErrorTracking(
  app: Hono<any>,
  options: InstallPostHogHonoErrorTrackingOptions,
): PostHogErrorTracker {
  const tracker = createPostHogErrorTracker(options);
  app.onError(async (err, c) => {
    await tracker.captureHonoException(err, c);
    if (err instanceof HTTPException && err.status < 500) {
      return err.getResponse();
    }
    if (options.onError) {
      return options.onError(err, c);
    }
    return c.json({ error: options.clientErrorMessage ?? DEFAULT_CLIENT_ERROR_MESSAGE }, 500);
  });
  return tracker;
}

export function createPostHogServerExceptionReporter(
  options: CreatePostHogErrorTrackerOptions,
): PostHogServerExceptionReporter {
  const tracker = createPostHogErrorTracker(options);
  return {
    enabled: tracker.enabled,
    captureException(error, input = {}) {
      const request = input.request;
      const context = input.context;
      return tracker.captureException(error, {
        distinctId: input.distinctId ?? extractPostHogDistinctId(readHeader(request?.headers, "cookie")),
        properties: {
          service: options.service,
          runtime: "nextjs",
          method: sanitizeMaybeString(request?.method),
          path: getRequestPath(request),
          route_type: sanitizeMaybeString(context?.routeType),
          route_path: sanitizeMaybeString(context?.routePath),
          router_kind: sanitizeMaybeString(context?.routerKind),
          ...input.properties,
        },
      });
    },
    shutdown() {
      return tracker.shutdown();
    },
  };
}

export function extractPostHogDistinctId(cookieHeader: string | string[] | null | undefined): string | undefined {
  const cookie = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (!cookie) return undefined;
  const match = cookie.match(/(?:^|;\s*)ph_phc_[^=;]*_posthog=([^;]+)/);
  if (!match?.[1]) return undefined;

  try {
    const decoded = decodeURIComponent(match[1]);
    const parsed = JSON.parse(decoded) as { distinct_id?: unknown };
    return typeof parsed.distinct_id === "string" && parsed.distinct_id.length > 0
      ? parsed.distinct_id
      : undefined;
  } catch (err: unknown) {
    if (err instanceof SyntaxError || err instanceof URIError) {
      return undefined;
    }
    throw err;
  }
}

function buildHonoProperties(service: string, c: Context): PostHogProperties {
  const url = safeUrl(c.req.url);
  const userAgent = c.req.header("user-agent");
  return {
    service,
    runtime: "hono",
    method: c.req.method,
    path: url?.pathname ?? c.req.path,
    query_present: Boolean(url?.search),
    user_agent: userAgent,
  };
}

function getHonoDistinctId(c: Context): string | undefined {
  return sanitizeDistinctId(
    c.req.header("x-matrix-user") ??
      c.req.header("x-platform-user-id") ??
      c.req.header("x-matrix-handle") ??
      extractPostHogDistinctId(c.req.header("cookie")),
  );
}

function getRequestPath(request: NextRequestLike | undefined): string | undefined {
  if (!request) return undefined;
  if (request.path) return sanitizeMaybeString(request.path);
  const url = safeUrl(request.url);
  return url?.pathname;
}

function readHeader(
  headers: NextRequestLike["headers"] | undefined,
  name: string,
): string | string[] | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  return record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
}

function firstEnv(env: EnvSource, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function sanitizeProperties(properties: PostHogProperties): Record<string, PrimitiveProperty> {
  const sanitized: Record<string, PrimitiveProperty> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      const next = value.slice(0, MAX_PROPERTY_LENGTH);
      if (next.length > 0) sanitized[key] = next;
    } else if (typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function sanitizeDistinctId(value: string | null | undefined): string | undefined {
  return sanitizeMaybeString(value);
}

function sanitizeMaybeString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const next = value.slice(0, MAX_PROPERTY_LENGTH);
  return next.length > 0 ? next : undefined;
}

function safeUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch (err: unknown) {
    if (err instanceof TypeError) {
      return undefined;
    }
    throw err;
  }
}

function errorKind(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
