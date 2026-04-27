import { defineCommand } from "citty";
import { isExpired, loadProfileAuth } from "../../auth/token-store.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";

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
      const auth = await loadProfileAuth(profile.name);
      const data = auth && !isExpired(auth)
        ? {
            profile: profile.name,
            authenticated: true,
            userId: auth.userId,
            handle: auth.handle,
          }
        : {
            profile: profile.name,
            authenticated: false,
          };

      if (json) {
        console.log(formatCliSuccess(data));
      } else if (data.authenticated) {
        console.log(`@${data.handle} (${data.profile})`);
      } else {
        console.log(`Not logged in (${data.profile}).`);
      }
    } catch (err: unknown) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
