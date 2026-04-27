import { defineCommand } from "citty";
import { isExpired, loadProfileAuth } from "../../auth/token-store.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";

interface InstanceRequestOptions {
  method?: "GET" | "POST";
}

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "instance_request_failed";
  console.error(json ? formatCliError(code) : `Error: Request failed (${code})`);
}

async function requestInstance(
  args: Record<string, unknown>,
  path: string,
  options: InstanceRequestOptions = {},
): Promise<Record<string, unknown>> {
  const profile = await resolveCliProfile(args);
  const auth = profile.token ? null : await loadProfileAuth(profile.name);
  const token = profile.token ?? (auth && !isExpired(auth) ? auth.accessToken : undefined);
  if (!token) {
    throw Object.assign(new Error("not_authenticated"), { code: "not_authenticated" });
  }

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
  run: () => {
    console.log("Usage: matrix instance info|restart|logs");
  },
});
