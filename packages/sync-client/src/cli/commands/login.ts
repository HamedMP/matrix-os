import { defineCommand } from "citty";
import { login } from "../../auth/oauth.js";
import { saveAuth } from "../../auth/token-store.js";
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
      console.log("Logged in (dev) as @dev");
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
    try {
      const meRes = await fetch(`${platformUrl}/api/me`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (meRes.ok) {
        const me = (await meRes.json()) as { gatewayUrl?: string };
        if (me.gatewayUrl) gatewayUrl = me.gatewayUrl;
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

    const next: SyncConfig = {
      platformUrl,
      gatewayUrl: gatewayUrl ?? existing?.gatewayUrl ?? platformUrl,
      syncPath: existing?.syncPath ?? defaultSyncPath(),
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
