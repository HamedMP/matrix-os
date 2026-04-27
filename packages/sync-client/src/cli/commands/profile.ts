import { defineCommand } from "citty";
import {
  loadProfiles,
  saveProfiles,
  setActiveProfile,
  type Profile,
  type ProfilesFile,
} from "../../lib/profiles.js";
import { formatCliError, formatCliSuccess } from "../output.js";

interface ProfileView extends Profile {
  name: string;
  active: boolean;
}

function profileView(name: string, profile: Profile, active: string): ProfileView {
  return {
    name,
    active: name === active,
    platformUrl: profile.platformUrl,
    gatewayUrl: profile.gatewayUrl,
  };
}

function listProfileViews(profiles: ProfilesFile): ProfileView[] {
  return Object.entries(profiles.profiles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, profile]) => profileView(name, profile, profiles.active));
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error(code), { code });
  }
  return value;
}

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : err instanceof Error && err.message
        ? err.message
        : "profile_failed";
  console.error(json ? formatCliError(code) : `Error: Request failed (${code})`);
}

async function runProfileCommand(
  args: Record<string, unknown>,
  handler: (json: boolean) => Promise<void>,
): Promise<void> {
  const json = args.json === true;
  try {
    await handler(json);
  } catch (err: unknown) {
    writeError(err, json);
    process.exitCode = 1;
  }
}

export const profileCommand = defineCommand({
  meta: {
    name: "profile",
    description: "Manage Matrix OS CLI profiles",
  },
  args: {
    json: { type: "boolean", required: false, default: false },
  },
  subCommands: {
    ls: defineCommand({
      meta: { name: "ls", description: "List CLI profiles" },
      args: {
        json: { type: "boolean", required: false, default: false },
      },
      run: async ({ args }) => runProfileCommand(args, async (json) => {
        const profiles = await loadProfiles();
        const data = {
          active: profiles.active,
          profiles: listProfileViews(profiles),
        };
        if (json) {
          console.log(formatCliSuccess(data));
          return;
        }
        for (const profile of data.profiles) {
          const marker = profile.active ? "*" : " ";
          console.log(`${marker} ${profile.name}\t${profile.gatewayUrl}`);
        }
      }),
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show one CLI profile" },
      args: {
        name: { type: "positional", required: false },
        json: { type: "boolean", required: false, default: false },
      },
      run: async ({ args }) => runProfileCommand(args, async (json) => {
        const profiles = await loadProfiles();
        const name = typeof args.name === "string" ? args.name : profiles.active;
        const profile = profiles.profiles[name];
        if (!profile) {
          throw Object.assign(new Error("profile_not_found"), { code: "profile_not_found" });
        }
        const data = profileView(name, profile, profiles.active);
        console.log(json ? formatCliSuccess({ ...data }) : `${data.name}\nPlatform: ${data.platformUrl}\nGateway: ${data.gatewayUrl}`);
      }),
    }),
    use: defineCommand({
      meta: { name: "use", description: "Set the active CLI profile" },
      args: {
        name: { type: "positional", required: true },
        json: { type: "boolean", required: false, default: false },
      },
      run: async ({ args }) => runProfileCommand(args, async (json) => {
        const name = requireString(args.name, "profile_name_required");
        await setActiveProfile(name);
        const data = { active: name };
        console.log(json ? formatCliSuccess(data) : `Active profile: ${name}`);
      }),
    }),
    set: defineCommand({
      meta: { name: "set", description: "Create or update a CLI profile" },
      args: {
        name: { type: "positional", required: true },
        platform: { type: "string", required: false },
        gateway: { type: "string", required: false },
        json: { type: "boolean", required: false, default: false },
      },
      run: async ({ args }) => runProfileCommand(args, async (json) => {
        const name = requireString(args.name, "profile_name_required");
        const profiles = await loadProfiles();
        const existing = profiles.profiles[name];
        const platformUrl =
          typeof args.platform === "string" ? args.platform : existing?.platformUrl;
        const gatewayUrl =
          typeof args.gateway === "string" ? args.gateway : existing?.gatewayUrl;
        if (!platformUrl || !gatewayUrl) {
          throw Object.assign(new Error("profile_urls_required"), { code: "profile_urls_required" });
        }
        const next: ProfilesFile = {
          active: profiles.active,
          profiles: {
            ...profiles.profiles,
            [name]: { platformUrl, gatewayUrl },
          },
        };
        await saveProfiles(next);
        const data = profileView(name, next.profiles[name]!, next.active);
        console.log(json ? formatCliSuccess({ ...data }) : `Saved profile: ${name}`);
      }),
    }),
  },
  run: () => {
    console.log("Usage: matrix profile ls|show|use|set");
  },
});
