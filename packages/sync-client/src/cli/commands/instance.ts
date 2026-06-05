import { defineCommand } from "citty";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { requireCliAuthToken } from "../auth-state.js";

const INSTANCE_USAGE = "Usage: matrix instance info|restart|logs";
const INSTANCE_SUBCOMMANDS = new Set(["info", "restart", "logs"]);
const INSTANCE_VALUE_OPTIONS = new Set(["--profile", "--platform", "--token"]);

interface InstanceRequestOptions {
  method?: "GET" | "POST";
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
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "instance_request_failed";
  const safeMessage =
    (code === "not_authenticated" || code === "auth_expired") && err instanceof Error
      ? err.message
      : undefined;
  console.error(json ? formatCliError(code, safeMessage) : safeMessage ?? `Error: Request failed (${code})`);
}

async function requestInstance(
  args: Record<string, unknown>,
  path: string,
  options: InstanceRequestOptions = {},
): Promise<Record<string, unknown>> {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);

  const res = await fetch(`${profile.platformUrl}${path}`, {
    ...(options.method ? { method: options.method } : {}),
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw Object.assign(new Error("instance_request_failed"), { code: "instance_request_failed" });
  }
  return (await res.json()) as Record<string, unknown>;
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
  profile: { type: "string", required: false },
  dev: { type: "boolean", required: false, default: false },
  platform: { type: "string", required: false },
  token: { type: "string", required: false },
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
      run: async ({ args }) => runInstanceCommand(args, "/api/instance"),
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
