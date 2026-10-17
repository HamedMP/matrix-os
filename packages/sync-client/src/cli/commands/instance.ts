import { defineCommand } from "citty";
import { z } from "zod/v4";
import { formatCliError, formatCliSuccess, isFetchTimeoutError } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { requireCliAuthToken } from "../auth-state.js";

const INSTANCE_USAGE = "Usage: matrix instance info|restart|logs";
const INSTANCE_SUBCOMMANDS = new Set(["info", "restart", "logs"]);
const INSTANCE_STRING_ARGS = {
  profile: { type: "string", required: false },
  service: { type: "string", required: false },
  lines: { type: "string", required: false },
  since: { type: "string", required: false },
  platform: { type: "string", required: false },
  gateway: { type: "string", required: false },
  token: { type: "string", required: false },
} as const;
const INSTANCE_VALUE_OPTIONS = new Set(
  Object.keys(INSTANCE_STRING_ARGS).map((name) => `--${name}`),
);

const LOG_SERVICES = new Set(["gateway", "shell", "sync", "code"]);
const MAX_LOG_LINES = 1000;
const MAX_LOG_SINCE_SECONDS = 7 * 86_400;
const SINCE_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
// Messages for these codes are authored by the CLI, never echoed from a server.
const CLI_AUTHORED_MESSAGE_CODES = new Set([
  "invalid_arguments",
  "instance_logs_unsupported",
  "instance_restart_unavailable",
]);

const InstanceLogsResponseSchema = z.object({
  service: z.string().max(32),
  lines: z.array(z.string().max(4096)).max(MAX_LOG_LINES),
  truncated: z.boolean(),
});

type InstanceUpstream = "gateway_system_info_api" | "gateway_system_logs_api";

interface InstanceFailureDetails extends Record<string, unknown> {
  upstream: InstanceUpstream;
  cause: string;
  retryable: boolean;
  httpStatus?: number;
}

type InstanceError = Error & {
  code: string;
  details?: Record<string, unknown>;
};

const UPSTREAM_FAILURE_MESSAGES: Record<InstanceUpstream, string> = {
  gateway_system_info_api: "Instance information request failed.",
  gateway_system_logs_api: "Instance logs request failed.",
};

function codedInstanceError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): InstanceError {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function requestFailure(
  upstream: InstanceUpstream,
  cause: InstanceFailureDetails["cause"],
  options: { httpStatus?: number; retryable?: boolean } = {},
): InstanceError {
  return codedInstanceError("instance_request_failed", UPSTREAM_FAILURE_MESSAGES[upstream], {
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
  const upstream = details?.upstream as InstanceUpstream | undefined;
  const safeMessage =
    (code === "not_authenticated" || code === "auth_expired" || CLI_AUTHORED_MESSAGE_CODES.has(code))
      && err instanceof Error
      ? err.message
      : code === "instance_request_failed"
        ? UPSTREAM_FAILURE_MESSAGES[upstream ?? "gateway_system_info_api"]
          ?? UPSTREAM_FAILURE_MESSAGES.gateway_system_info_api
        : undefined;
  if (json) {
    console.error(formatCliError(code, safeMessage, details));
    return;
  }
  const nextStep = typeof details?.nextStep === "string" ? ` ${details.nextStep}` : "";
  const directStatus = typeof details?.httpStatus === "number" ? ` HTTP ${details.httpStatus}.` : "";
  console.error(`${safeMessage ?? `Error: Request failed (${code})`}${directStatus}${nextStep}`);
}

async function requestGateway(
  args: Record<string, unknown>,
  path: string,
  upstream: InstanceUpstream,
): Promise<Record<string, unknown>> {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);

  let res: Response;
  try {
    res = await fetch(`${profile.gatewayUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    throw requestFailure(upstream, isFetchTimeoutError(err) ? "timeout" : "network");
  }
  if (!res.ok) {
    if (upstream === "gateway_system_logs_api" && res.status === 404) {
      throw codedInstanceError("instance_logs_unsupported", "This Matrix computer does not support logs yet.", {
        upstream,
        cause: "http",
        httpStatus: 404,
        retryable: false,
        nextStep: "Update your Matrix computer, then try again.",
      });
    }
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

function invalidArguments(message: string): InstanceError {
  return codedInstanceError("invalid_arguments", message, { retryable: false });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Validate locally so bad flags fail without a request; the gateway re-validates. */
function buildLogsPath(args: Record<string, unknown>): string {
  const service = optionalString(args.service) ?? "gateway";
  if (!LOG_SERVICES.has(service)) {
    throw invalidArguments("--service must be one of gateway, shell, sync, code.");
  }
  const lines = optionalString(args.lines) ?? "200";
  if (!/^\d{1,4}$/.test(lines) || Number(lines) < 1 || Number(lines) > MAX_LOG_LINES) {
    throw invalidArguments(`--lines must be a whole number from 1 to ${MAX_LOG_LINES}.`);
  }
  const since = optionalString(args.since);
  if (since !== undefined) {
    const match = /^(\d{1,6})([smhd])$/.exec(since);
    const seconds = match ? Number(match[1]) * SINCE_UNIT_SECONDS[match[2]] : 0;
    if (seconds < 1 || seconds > MAX_LOG_SINCE_SECONDS) {
      throw invalidArguments("--since must look like 30m, 2h, or 1d, up to 7d.");
    }
  }
  const query = new URLSearchParams({ service, lines, ...(since ? { since } : {}) });
  return `/api/system/logs?${query.toString()}`;
}

async function runInstanceInfo(args: Record<string, unknown>): Promise<void> {
  const json = args.json === true;
  try {
    const data = await requestGateway(args, "/api/system/info", "gateway_system_info_api");
    console.log(json ? formatCliSuccess(data) : JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    writeError(err, json);
    process.exitCode = 1;
  }
}

async function runInstanceLogs(args: Record<string, unknown>): Promise<void> {
  const json = args.json === true;
  try {
    const path = buildLogsPath(args);
    const data = await requestGateway(args, path, "gateway_system_logs_api");
    const parsed = InstanceLogsResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw requestFailure("gateway_system_logs_api", "invalid_response", { retryable: false });
    }
    if (json) {
      console.log(formatCliSuccess(parsed.data));
      return;
    }
    if (parsed.data.lines.length === 0) {
      console.log(`No log entries for ${parsed.data.service}.`);
      return;
    }
    for (const line of parsed.data.lines) console.log(line);
    if (parsed.data.truncated) console.error("Some long lines were shortened.");
  } catch (err: unknown) {
    writeError(err, json);
    process.exitCode = 1;
  }
}

function runInstanceRestart(args: Record<string, unknown>): void {
  writeError(codedInstanceError("instance_restart_unavailable", "Instance restart is not available yet.", {
    retryable: false,
    nextStep: "Run `matrix doctor` to check your Matrix computer.",
  }), args.json === true);
  process.exitCode = 1;
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
      meta: { name: "restart", description: "Restart the active Matrix OS instance (not available yet)" },
      args: commonArgs,
      run: async ({ args }) => runInstanceRestart(args),
    }),
    logs: defineCommand({
      meta: { name: "logs", description: "Show recent redacted logs from the active Matrix OS instance" },
      args: {
        ...commonArgs,
        service: { type: "string", required: false, description: "gateway (default), shell, sync, or code" },
        lines: { type: "string", required: false, description: "Number of lines, 1-1000 (default 200)" },
        since: { type: "string", required: false, description: "Time window such as 30m, 2h, or 1d (max 7d)" },
      },
      run: async ({ args }) => runInstanceLogs(args),
    }),
  },
  run: ({ rawArgs }) => {
    if (!hasInstanceSubCommand(rawArgs)) {
      console.log(INSTANCE_USAGE);
    }
  },
});
