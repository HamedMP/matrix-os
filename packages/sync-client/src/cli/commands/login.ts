import { defineCommand } from "citty";
import { login } from "../../auth/oauth.js";
import { clearAuth, saveAuth } from "../../auth/token-store.js";
import {
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
      description: "Override platform URL (default: from config or platform.matrix-os.com)",
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

    // Discover the user's gateway URL via /api/me. The platform owns the
    // mapping (clerkUserId -> handle -> gateway endpoint); the CLI persists
    // the result so the daemon knows where to point.
    let gatewayUrl: string | undefined;
    let noContainer = false;
    try {
      const meRes = await fetch(`${platformUrl}/api/me`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (meRes.status === 404) {
        noContainer = true;
      } else if (meRes.ok) {
        const me = (await meRes.json()) as { gatewayUrl?: string };
        if (me.gatewayUrl) {
          gatewayUrl = me.gatewayUrl;
        } else {
          noContainer = true;
        }
      } else {
        console.error(
          `Warning: /api/me returned ${meRes.status} -- gatewayUrl not discovered. Set it manually in ~/.matrixos/config.json.`,
        );
      }
    } catch (err) {
      console.error(
        `Warning: failed to fetch /api/me: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (noContainer) {
      // Don't persist auth.json or config.json in this half-provisioned
      // state. `pollForToken` already wrote auth.json inside `login()`, so
      // clear it — leaving it around would make `matrix sync` appear to work
      // while every gateway call 404s.
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

    const next: SyncConfig = {
      platformUrl,
      gatewayUrl: gatewayUrl ?? existing?.gatewayUrl ?? platformUrl,
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
