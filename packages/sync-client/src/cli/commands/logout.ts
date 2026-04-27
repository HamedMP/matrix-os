import { defineCommand } from "citty";
import { clearProfileAuth } from "../../auth/token-store.js";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliSuccess } from "../output.js";

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "logout_failed";
  console.error(json ? formatCliError(code) : `Error: Request failed (${code})`);
}

export const logoutCommand = defineCommand({
  meta: { name: "logout", description: "Log out of Matrix OS" },
  args: {
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    json: { type: "boolean", required: false, default: false },
  },
  run: async ({ args }) => {
    const json = args.json === true;
    try {
      const profile = await resolveCliProfile(args);
      await clearProfileAuth(profile.name);
      const data = { profile: profile.name, loggedOut: true };
      console.log(json ? formatCliSuccess(data) : `Logged out of ${profile.name}.`);
    } catch (err: unknown) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
