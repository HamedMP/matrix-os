import { defineCommand } from "citty";
import { formatCliError, formatCliSuccess, isFetchTimeoutError } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { requireCliAuthToken } from "../auth-state.js";

const INSTANCE_USAGE = "Usage: matrix instance info|restart|logs";
const INSTANCE_SUBCOMMANDS = new Set(["info", "restart", "logs"]);
const INSTANCE_STRING_ARGS = {
  profile: { type: "string", required: false },
  platform: { type: "string", required: false },
  gateway: { type: "string", required: false },
  token: { type: "string", required: false },
} as const;
const INSTANCE_VALUE_OPTIONS = new Set(
  Object.keys(INSTANCE_STRING_ARGS).map((name) => `--${name}`),
);

interface InstanceRequestOptions {
  method?: "GET" | "POST";
  target?: "gateway" | "platform";
}

interface InstanceFailureDetails extends Record<string, unknown> {
  upstream: "gateway_system_info_api" | "platform_instance_api";
  cause: string;
  retryable: boolean;
  httpStatus?: number;
}

type InstanceError = Error & {
  code: string;
  details?: Record<string, unknown>;
};

function codedInstanceError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): InstanceError {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function requestFailure(
  upstream: InstanceFailureDetails["upstream"],
  cause: InstanceFailureDetails["cause"],
  options: { httpStatus?: number; retryable?: boolean } = {},
): InstanceError {
  const message = upstream === "gateway_system_info_api"
    ? "Instance information request failed."
    : "Instance management request failed.";
  return codedInstanceError("instance_request_failed", message, {
    upstream,
    cause,
    ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
    retryable: options.retryable ?? true,
  });
}

function safeDetails(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof Error) || !("details" in err)) {
    return undefined;
  }
  const details = (err as { details?: unknown }).details;
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? details as Record<string, unknown>
    : undefined;
}

function errorCode(err: unknown, fallback: string): string {
  return err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : fallback;
}

function hasInstanceSubCommand(rawArgs: string[] | undefined): boolean {
  if (!Array.isArray(rawArgs)) {
    return false;
  }
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg.startsWith("--")) {
      const [option] = arg.split("=", 1);
      if (INSTANCE_VALUE_OPTIONS.has(option) && !arg.includes("=")) {
        i += 1;
      }
      continue;
    }
    return INSTANCE_SUBCOMMANDS.has(arg);
  }
  return false;
}

function writeError(err: unknown, json: boolean): void {
  const code = errorCode(err, "instance_request_failed");
  const details = safeDetails(err);
  const safeMessage =
    (code === "not_authenticated" || code === "auth_expired") && err instanceof Error
      ? err.message
      : code === "instance_request_failed"
        ? details?.upstream === "gateway_system_info_api"
          ? "Instance information request failed."
          : "Instance management request failed."
        : undefined;
  if (json) {
    console.error(formatCliError(code, safeMessage, details));
    return;
  }
  const nextStep = typeof details?.nextStep === "string" ? ` ${details.nextStep}` : "";
  const directStatus = typeof details?.httpStatus === "number" ? ` HTTP ${details.httpStatus}.` : "";
  console.error(`${safeMessage ?? `Error: Request failed (${code})`}${directStatus}${nextStep}`);
}

async function requestInstance(
  args: Record<string, unknown>,
  path: string,
  options: InstanceRequestOptions = {},
): Promise<Record<string, unknown>> {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  const target = options.target ?? "platform";
  const baseUrl = target === "gateway" ? profile.gatewayUrl : profile.platformUrl;
  const upstream: InstanceFailureDetails["upstream"] = target === "gateway"
    ? "gateway_system_info_api"
    : "platform_instance_api";

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...(options.method ? { method: options.method } : {}),
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    throw requestFailure(upstream, isFetchTimeoutError(err) ? "timeout" : "network");
  }
  if (!res.ok) {
    throw requestFailure(upstream, "http", {
      httpStatus: res.status,
      retryable: res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500,
    });
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err: unknown) {
    throw requestFailure(
      upstream,
      err instanceof SyntaxError ? "invalid_response" : "response_read_failed",
      { retryable: false },
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw requestFailure(upstream, "invalid_response", { retryable: false });
  }
  return data as Record<string, unknown>;
}

async function runInstanceInfo(args: Record<string, unknown>): Promise<void> {
  await runInstanceCommand(args, "/api/system/info", { target: "gateway" });
}

async function runInstanceCommand(
  args: Record<string, unknown>,
  path: string,
  options: InstanceRequestOptions = {},
): Promise<void> {
  const json = args.json === true;
  try {
    const data = await requestInstance(args, path, options);
    console.log(json ? formatCliSuccess(data) : JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    writeError(err, json);
    process.exitCode = 1;
  }
}

const commonArgs = {
  profile: INSTANCE_STRING_ARGS.profile,
  dev: { type: "boolean", required: false, default: false },
  platform: INSTANCE_STRING_ARGS.platform,
  gateway: INSTANCE_STRING_ARGS.gateway,
  token: INSTANCE_STRING_ARGS.token,
  json: { type: "boolean", required: false, default: false },
} as const;

export const instanceCommand = defineCommand({
  meta: {
    name: "instance",
    description: "Manage the active Matrix OS instance",
  },
  args: commonArgs,
  subCommands: {
    info: defineCommand({
      meta: { name: "info", description: "Show active Matrix OS instance info" },
      args: commonArgs,
      run: async ({ args }) => runInstanceInfo(args),
    }),
    restart: defineCommand({
      meta: { name: "restart", description: "Restart the active Matrix OS instance" },
      args: commonArgs,
      run: async ({ args }) => runInstanceCommand(args, "/api/instance/restart", { method: "POST" }),
    }),
    logs: defineCommand({
      meta: { name: "logs", description: "Show active Matrix OS instance logs" },
      args: commonArgs,
      run: async ({ args }) => runInstanceCommand(args, "/api/instance/logs"),
    }),
  },
  run: ({ rawArgs }) => {
    if (!hasInstanceSubCommand(rawArgs)) {
      console.log(INSTANCE_USAGE);
    }
  },
});
