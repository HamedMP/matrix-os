import { defineCommand } from "citty";
import { isExpired, loadProfileAuth } from "../../auth/token-store.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "status_failed";
  console.error(json ? formatCliError(code) : `Error: Request failed (${code})`);
}

export const statusCommand = defineCommand({
  meta: { name: "status", description: "Show Matrix OS profile and gateway status" },
  args: {
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    gateway: { type: "string", required: false },
    token: { type: "string", required: false },
    json: { type: "boolean", required: false, default: false },
  },
  run: async ({ args }) => {
    const json = args.json === true;
    try {
      const profile = await resolveCliProfile(args);
      const auth = profile.token ? null : await loadProfileAuth(profile.name);
      const token = profile.token ?? (auth && !isExpired(auth) ? auth.accessToken : undefined);
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      const res = await fetch(`${profile.gatewayUrl}/api/health`, {
        ...(headers ? { headers } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      const body = res.ok ? ((await res.json()) as { status?: unknown }) : {};
      const data = {
        profile: profile.name,
        gatewayUrl: profile.gatewayUrl,
        authenticated: !!token,
        gateway: {
          reachable: res.ok,
          status: typeof body.status === "string" ? body.status : res.ok ? "ok" : "unreachable",
        },
      };

      if (json) {
        console.log(formatCliSuccess(data));
      } else {
        console.log(`Profile: ${data.profile}`);
        console.log(`Gateway: ${data.gatewayUrl} (${data.gateway.status})`);
        console.log(`Authenticated: ${data.authenticated ? "yes" : "no"}`);
      }
    } catch (err: unknown) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
