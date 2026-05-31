import { defineCommand } from "citty";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { probeGatewayHealth } from "../gateway-health.js";
import { resolveCliAuthStatus } from "../auth-state.js";

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
      const authStatus = await resolveCliAuthStatus(profile);
      const token = authStatus.status === "authenticated" ? authStatus.token : undefined;
      const gateway = await probeGatewayHealth(profile.gatewayUrl, token);
      const data = {
        profile: profile.name,
        gatewayUrl: profile.gatewayUrl,
        authenticated: !!token,
        ...(authStatus.status === "expired" ? { auth: "expired" as const } : {}),
        gateway,
      };

      if (json) {
        console.log(formatCliSuccess(data));
      } else {
        console.log(`Profile: ${data.profile}`);
        console.log(`Gateway: ${data.gatewayUrl} (${data.gateway.status})`);
        console.log(`Authenticated: ${data.authenticated ? "yes" : authStatus.status === "expired" ? "expired" : "no"}`);
      }
    } catch (err: unknown) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
