import { defineCommand } from "citty";
import { formatCliError, formatCliSuccess, isFetchTimeoutError } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { requireCliAuthToken } from "../auth-state.js";
import { createShellClient } from "../shell-client.js";

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
}

interface InstanceFailureDetails extends Record<string, unknown> {
  upstream: "platform_instance_api" | "instance_execution_api";
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

function managementFailure(
  cause: InstanceFailureDetails["cause"],
  options: { httpStatus?: number; retryable?: boolean } = {},
): InstanceError {
  return codedInstanceError("instance_request_failed", "Instance management request failed.", {
    upstream: "platform_instance_api",
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
  const safeMessage =
    (code === "not_authenticated" || code === "auth_expired") && err instanceof Error
      ? err.message
      : code === "instance_request_failed"
        ? "Instance management request failed."
        : code === "instance_unavailable"
          ? "Instance readiness check failed."
          : undefined;
  const details = safeDetails(err);
  if (json) {
    console.error(formatCliError(code, safeMessage, details));
    return;
  }
  const nextStep = typeof details?.nextStep === "string" ? ` ${details.nextStep}` : "";
  const management = details?.management;
  const directStatus = typeof details?.httpStatus === "number" ? ` HTTP ${details.httpStatus}.` : "";
  const degradedStatus =
    typeof management === "object" && management !== null && "httpStatus" in management &&
      typeof (management as { httpStatus?: unknown }).httpStatus === "number"
      ? ` Management API returned HTTP ${(management as { httpStatus: number }).httpStatus}.`
      : "";
  console.error(`${safeMessage ?? `Error: Request failed (${code})`}${directStatus}${degradedStatus}${nextStep}`);
}

async function requestInstance(
  args: Record<string, unknown>,
  path: string,
  options: InstanceRequestOptions = {},
): Promise<Record<string, unknown>> {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);

  let res: Response;
  try {
    res = await fetch(`${profile.platformUrl}${path}`, {
      ...(options.method ? { method: options.method } : {}),
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    throw managementFailure(isFetchTimeoutError(err) ? "timeout" : "network");
  }
  if (!res.ok) {
    throw managementFailure("http", {
      httpStatus: res.status,
      retryable: res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500,
    });
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err: unknown) {
    throw managementFailure(
      err instanceof SyntaxError ? "invalid_response" : "response_read_failed",
      { retryable: false },
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw managementFailure("invalid_response", { retryable: false });
  }
  return data as Record<string, unknown>;
}

async function probeInstanceExecution(args: Record<string, unknown>): Promise<void> {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  try {
    const result = await createShellClient({ gatewayUrl: profile.gatewayUrl, token }).runCommand({
      command: ["true"],
      timeoutMs: 10_000,
    });
    if (result.timedOut) {
      throw codedInstanceError("request_timeout", "Request failed");
    }
    if (result.exitCode !== 0) {
      throw codedInstanceError("command_failed", "Request failed");
    }
  } catch (err: unknown) {
    const code = errorCode(err, "request_failed");
    throw codedInstanceError("instance_execution_failed", "Instance execution probe failed.", {
      upstream: "instance_execution_api",
      cause: code === "request_timeout" ? "timeout" : code,
      retryable: true,
    });
  }
}

async function runInstanceInfo(args: Record<string, unknown>): Promise<void> {
  const json = args.json === true;
  try {
    const data = await requestInstance(args, "/api/instance");
    console.log(json ? formatCliSuccess(data) : JSON.stringify(data, null, 2));
  } catch (managementError: unknown) {
    if (errorCode(managementError, "instance_request_failed") !== "instance_request_failed") {
      writeError(managementError, json);
      process.exitCode = 1;
      return;
    }
    try {
      await probeInstanceExecution(args);
      const data = {
        status: "running",
        ready: true,
        source: "execution_probe",
        management: {
          status: "degraded",
          ...safeDetails(managementError),
        },
        nextStep: "Execution is healthy. Retry `matrix instance info` for full metadata.",
      };
      console.log(json ? formatCliSuccess(data) : JSON.stringify(data, null, 2));
    } catch (executionError: unknown) {
      writeError(codedInstanceError("instance_unavailable", "Instance readiness check failed.", {
        management: safeDetails(managementError) ?? {
          upstream: "platform_instance_api",
          cause: "request_failed",
          retryable: true,
        },
        execution: safeDetails(executionError) ?? {
          upstream: "instance_execution_api",
          cause: "request_failed",
          retryable: true,
        },
        nextStep: "Run `matrix doctor`, then retry `matrix instance info`.",
      }), json);
      process.exitCode = 1;
    }
  }
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
