import { defineCommand } from "citty";
import { login } from "../../auth/oauth.js";
import { clearAuth, saveAuth } from "../../auth/token-store.js";
import {
  defaultGatewayUrl,
  defaultPlatformUrl,
  defaultSyncPath,
  generatePeerId,
  loadConfig,
  saveConfig,
  type SyncConfig,
} from "../../lib/config.js";

export const loginCommand = defineCommand({
  meta: { name: "login", description: "Log in to Matrix OS" },
  args: {
    dev: {
      type: "boolean",
      description:
        "Skip the device flow and write a stub auth.json. Dev only -- the gateway must be running with no MATRIX_AUTH_TOKEN.",
      default: false,
    },
    platform: {
      type: "string",
      description: "Override platform URL (default: from config or app.matrix-os.com)",
    },
  },
  run: async (ctx) => {
    if (ctx.args.dev) {
      // Dev-only shortcut. Bypass the device flow so devs can run the
      // daemon without a Clerk session. The gateway in dev mode (no
      // MATRIX_AUTH_TOKEN) accepts any bearer.
      await saveAuth({
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
        platformUrl: process.env.MATRIXOS_PLATFORM_URL ?? "http://localhost:9000",
        gatewayUrl: process.env.MATRIXOS_GATEWAY_URL ?? "http://localhost:4000",
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

      console.log("Logged in (dev) as @dev");
      console.log(`Gateway: ${next.gatewayUrl}`);
      console.log(`Platform: ${next.platformUrl}`);
      return;
    }

    const existing = await loadConfig();
    const platformUrl =
      (typeof ctx.args.platform === "string" && ctx.args.platform) ||
      existing?.platformUrl ||
      defaultPlatformUrl();

    console.log(`Opening browser for authentication at ${platformUrl}...`);

    const auth = await login({
      platformUrl,
      clientId: "matrixos-cli",
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
      await clearAuth();
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

    const next: SyncConfig = {
      platformUrl,
      // Prefer the server-supplied gatewayUrl (PR 1 always returns
      // app.matrix-os.com); fall back to the client's known default
      // before ever reusing platformUrl, because a dev override of
      // `--platform http://localhost:9000` must NOT become the gatewayUrl.
      gatewayUrl: gatewayUrl ?? existing?.gatewayUrl ?? defaultGatewayUrl(),
      syncPath: existing?.syncPath ?? defaultSyncPath(),
      gatewayFolder: existing?.gatewayFolder ?? "",
      peerId: existing?.peerId ?? generatePeerId(),
      folders: existing?.folders,
      exclude: existing?.exclude,
      pauseSync: existing?.pauseSync ?? false,
    };
    await saveConfig(next);

    console.log(`Logged in as @${auth.handle}`);
    if (gatewayUrl) console.log(`Gateway: ${gatewayUrl}`);
  },
});
