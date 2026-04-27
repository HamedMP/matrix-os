import { defineCommand } from "citty";
import { login } from "../../auth/oauth.js";
import {
  authFilePathForProfile,
  clearProfileAuth,
  saveProfileAuth,
} from "../../auth/token-store.js";
import {
  defaultGatewayUrl,
  defaultPlatformUrl,
  defaultSyncPath,
  generatePeerId,
  loadConfig,
  saveConfig,
  type SyncConfig,
} from "../../lib/config.js";
import { loadProfiles, saveProfiles, type ProfilesFile } from "../../lib/profiles.js";
import { formatCliError, formatCliSuccess } from "../output.js";

function localProfileFromArgs(args: Record<string, unknown>) {
  return {
    platformUrl:
      (typeof args.platform === "string" && args.platform) ||
      process.env.MATRIXOS_PLATFORM_URL ||
      "http://localhost:9000",
    gatewayUrl:
      (typeof args.gateway === "string" && args.gateway) ||
      process.env.MATRIXOS_GATEWAY_URL ||
      "http://localhost:4000",
  };
}

async function saveProfile(
  profiles: ProfilesFile,
  name: string,
  profile: { platformUrl: string; gatewayUrl: string },
): Promise<void> {
  await saveProfiles({
    active: name,
    profiles: {
      ...profiles.profiles,
      [name]: profile,
    },
  });
}

function writeLoginError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "login_failed";
  console.error(json ? formatCliError(code) : `Error: Request failed (${code})`);
}

export const loginCommand = defineCommand({
  meta: { name: "login", description: "Log in to Matrix OS" },
  args: {
    profile: {
      type: "string",
      description: "Profile to authenticate (default: active profile)",
      required: false,
    },
    dev: {
      type: "boolean",
      description:
        "Skip the device flow and authenticate the local profile. Dev only -- the gateway must be running with no MATRIX_AUTH_TOKEN.",
      default: false,
    },
    platform: {
      type: "string",
      description: "Override platform URL (default: from config or app.matrix-os.com)",
    },
    gateway: {
      type: "string",
      description: "Override gateway URL for the authenticated profile",
      required: false,
    },
    json: { type: "boolean", required: false, default: false },
  },
  run: async (ctx) => {
    const json = ctx.args.json === true;
    try {
      if (ctx.args.dev) {
        // Dev-only shortcut. Bypass the device flow so devs can run the
        // daemon without a Clerk session. The gateway in dev mode (no
        // MATRIX_AUTH_TOKEN) accepts any bearer.
        const profiles = await loadProfiles();
        const localProfile = localProfileFromArgs(ctx.args);
        await saveProfile(profiles, "local", localProfile);
        await saveProfileAuth("local", {
          accessToken: "dev-token",
          expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
          userId: "user_dev",
          handle: process.env.MATRIX_HANDLE ?? "dev",
        });

      // Also stamp localhost endpoints into config so the daemon points at
      // the local docker stack instead of matrix-os.com. Preserve syncPath
      // and peerId if a config already exists.
        const existingDev = await loadConfig();
        const next: SyncConfig = {
          platformUrl: localProfile.platformUrl,
          gatewayUrl: localProfile.gatewayUrl,
          syncPath: existingDev?.syncPath ?? defaultSyncPath(),
          // Empty = full-mirror of the container's home. First-run should see
          // every file the container has, not a basename-filtered slice.
          gatewayFolder: existingDev?.gatewayFolder ?? "",
          peerId: existingDev?.peerId ?? generatePeerId(),
          folders: existingDev?.folders,
          exclude: existingDev?.exclude,
          pauseSync: existingDev?.pauseSync ?? false,
        };
        await saveConfig(next);

        const data = {
          profile: "local",
          handle: process.env.MATRIX_HANDLE ?? "dev",
          gatewayUrl: next.gatewayUrl,
          platformUrl: next.platformUrl,
        };
        if (json) {
          console.log(formatCliSuccess(data));
        } else {
          console.log("Logged in (dev) as @dev");
          console.log(`Gateway: ${next.gatewayUrl}`);
          console.log(`Platform: ${next.platformUrl}`);
        }
        return;
      }

    const existing = await loadConfig();
    const profiles = await loadProfiles();
    const profileName = typeof ctx.args.profile === "string" ? ctx.args.profile : profiles.active;
    const profile = profiles.profiles[profileName];
    if (!profile) {
      throw Object.assign(new Error("profile_not_found"), { code: "profile_not_found" });
    }
    const platformUrl =
      (typeof ctx.args.platform === "string" && ctx.args.platform) ||
      profile.platformUrl ||
      existing?.platformUrl ||
      defaultPlatformUrl();

    console.log(`Opening browser for authentication at ${platformUrl}...`);

    const auth = await login({
      platformUrl,
      clientId: "matrixos-cli",
      tokenStorePath: authFilePathForProfile(profileName),
    });

    // Discover the user's gateway URL via /api/me. Contract: 404 means the
    // user has no container yet (the ONLY "no container" signal); 200 always
    // carries a `gatewayUrl`. Any other response or a fetch throw is treated
    // as transient — we preserve the existing auth.json so the user can retry
    // without redoing the device flow, and we skip writing config.json so we
    // don't leave a half-provisioned state pointing at a guessed gateway.
    let gatewayUrl: string | undefined;
    let meRes: Response;
    try {
      meRes = await fetch(`${platformUrl}/api/me`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error(
        `Could not reach ${platformUrl}/api/me (${err instanceof Error ? err.message : "network error"}). Your auth token was saved — re-run \`matrix login\` once the platform is reachable.`,
      );
      return;
    }

    if (meRes.status === 404) {
      // User signed in but no Matrix container exists. Wipe the just-written
      // auth.json (pollForToken persisted it inside `login()`) — otherwise
      // `matrix sync` would appear to work while every gateway call 404s.
      await clearProfileAuth(profileName);
      console.log(
        "You're signed in, but there's no Matrix instance for this account yet.",
      );
      console.log("");
      console.log(
        "Sign up at https://app.matrix-os.com first, then re-run `matrix login`.",
      );
      return;
    }

    if (!meRes.ok) {
      // 5xx, 400, 502, etc. Keep the auth token (transient server issue) and
      // skip the config write — writing a config with a guessed gatewayUrl
      // is the exact half-provisioned state the 404 branch above prevents.
      console.error(
        `/api/me returned ${meRes.status}. Your auth token was saved — re-run \`matrix login\` once the platform recovers.`,
      );
      return;
    }

    const me = (await meRes.json()) as { gatewayUrl?: string };
    if (me.gatewayUrl) {
      gatewayUrl = me.gatewayUrl;
    }

    const gatewayOverride = typeof ctx.args.gateway === "string" && ctx.args.gateway
      ? ctx.args.gateway
      : undefined;
    const next: SyncConfig = {
      platformUrl,
      // Prefer the server-supplied gatewayUrl (PR 1 always returns
      // app.matrix-os.com); fall back to the client's known default
      // before ever reusing platformUrl, because a dev override of
      // `--platform http://localhost:9000` must NOT become the gatewayUrl.
      gatewayUrl: gatewayOverride ??
        gatewayUrl ??
        profile.gatewayUrl ??
        existing?.gatewayUrl ??
        defaultGatewayUrl(),
      syncPath: existing?.syncPath ?? defaultSyncPath(),
      gatewayFolder: existing?.gatewayFolder ?? "",
      peerId: existing?.peerId ?? generatePeerId(),
      folders: existing?.folders,
      exclude: existing?.exclude,
      pauseSync: existing?.pauseSync ?? false,
    };
    await saveConfig(next);
    await saveProfile(profiles, profileName, {
      platformUrl,
      gatewayUrl: next.gatewayUrl,
    });

    const data = {
      profile: profileName,
      handle: auth.handle,
      gatewayUrl: next.gatewayUrl,
      platformUrl,
    };
    if (json) {
      console.log(formatCliSuccess(data));
    } else {
      console.log(`Logged in as @${auth.handle}`);
      console.log(`Gateway: ${next.gatewayUrl}${gatewayUrl ? "" : " (default)"}`);
    }
    } catch (err: unknown) {
      writeLoginError(err, json);
      process.exitCode = 1;
    }
  },
});
