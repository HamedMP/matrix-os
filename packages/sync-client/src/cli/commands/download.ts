import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { downloadRemoteFile } from "../file-transfer-client.js";

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "download_failed";
  const safeMessage = err instanceof Error ? err.message : undefined;
  console.error(json ? formatCliError(code, safeMessage) : safeMessage ?? `Error: Request failed (${code})`);
}

export const downloadCommand = defineCommand({
  meta: {
    name: "download",
    description: "Download one file from your Matrix computer",
  },
  args: {
    remote: {
      type: "positional",
      required: true,
      description: "Source file in your Matrix home",
    },
    local: {
      type: "positional",
      required: true,
      description: "Local destination path on this computer",
    },
    force: { type: "boolean", required: false, default: false },
    secret: { type: "boolean", required: false, default: false },
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
      const token = await requireCliAuthToken(profile);
      const result = await downloadRemoteFile(
        { gatewayUrl: profile.gatewayUrl, token },
        String(args.remote),
        String(args.local),
        { force: args.force === true, secret: args.secret === true },
      );
      console.log(
        json
          ? formatCliSuccess(result)
          : `Downloaded ${args.remote} to ${result.path} (${result.size} bytes)`,
      );
    } catch (err) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
