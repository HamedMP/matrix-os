import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { uploadLocalFile } from "../file-transfer-client.js";

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "upload_failed";
  const safeMessage = err instanceof Error ? err.message : undefined;
  console.error(json ? formatCliError(code, safeMessage) : safeMessage ?? `Error: Request failed (${code})`);
}

export const uploadCommand = defineCommand({
  meta: {
    name: "upload",
    description: "Upload one local file to your Matrix computer",
  },
  args: {
    local: {
      type: "positional",
      required: true,
      description: "Local file path on this computer",
    },
    remote: {
      type: "positional",
      required: true,
      description: "Destination file or existing folder in your Matrix home",
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
      const result = await uploadLocalFile(
        { gatewayUrl: profile.gatewayUrl, token },
        String(args.local),
        String(args.remote),
        { force: args.force === true, secret: args.secret === true },
      );
      console.log(
        json
          ? formatCliSuccess(result)
          : `Uploaded ${result.path} (${result.size} bytes)`,
      );
    } catch (err) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
