import { loadProfiles, type ProfilesFile } from "../lib/profiles.js";

export interface CliProfileFlags {
  profile?: unknown;
  dev?: unknown;
  platform?: unknown;
  gateway?: unknown;
  token?: unknown;
}

export interface ResolvedCliProfile {
  name: string;
  platformUrl: string;
  gatewayUrl: string;
  token?: string;
  profiles: ProfilesFile;
}

export async function resolveCliProfile(
  flags: CliProfileFlags,
  configDir?: string,
): Promise<ResolvedCliProfile> {
  const profiles = await loadProfiles({ configDir });
  const explicitProfile =
    flags.dev === true ? "local" : typeof flags.profile === "string" ? flags.profile : profiles.active;
  const profile = profiles.profiles[explicitProfile];
  if (!profile) {
    throw new Error("profile_not_found");
  }

  return {
    name: explicitProfile,
    platformUrl: typeof flags.platform === "string" ? flags.platform : profile.platformUrl,
    gatewayUrl: typeof flags.gateway === "string" ? flags.gateway : profile.gatewayUrl,
    token: typeof flags.token === "string" ? flags.token : undefined,
    profiles,
  };
}
