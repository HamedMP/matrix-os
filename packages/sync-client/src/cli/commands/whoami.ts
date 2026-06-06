import { defineCommand } from "citty";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { resolveCliAuthStatus } from "../auth-state.js";

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "whoami_failed";
  console.error(json ? formatCliError(code) : `Error: Request failed (${code})`);
}

export const whoamiCommand = defineCommand({
  meta: { name: "whoami", description: "Show the authenticated Matrix OS identity" },
  args: {
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    json: { type: "boolean", required: false, default: false },
  },
  run: async ({ args }) => {
    const json = args.json === true;
    try {
      const profile = await resolveCliProfile(args);
      const authStatus = await resolveCliAuthStatus(profile);
      const data = {
        profile: profile.name,
        authenticated: authStatus.status === "authenticated",
        ...(authStatus.status === "authenticated" && authStatus.auth
          ? {
              userId: authStatus.auth.userId,
              handle: authStatus.auth.handle,
            }
          : {}),
        ...(authStatus.status === "expired" ? { auth: "expired" as const } : {}),
      };

      if (json) {
        console.log(formatCliSuccess(data));
      } else if (data.authenticated && "handle" in data) {
        console.log(`@${data.handle} (${data.profile})`);
      } else if (data.authenticated) {
        console.log(`Authenticated with explicit token (${data.profile}).`);
      } else if ("auth" in data && data.auth === "expired") {
        console.log(`Login expired (${data.profile}). Run \`mos login --profile ${data.profile}\` to refresh.`);
      } else {
        console.log(`Not logged in (${data.profile}).`);
      }
    } catch (err: unknown) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
