import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";

interface PeerStatus {
  peers?: { peerId: string; hostname: string; connectedAt: number }[];
}

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "peers_request_failed";
  const safeMessage =
    (code === "not_authenticated" || code === "auth_expired") && err instanceof Error
      ? err.message
      : undefined;
  console.error(json ? formatCliError(code, safeMessage) : safeMessage ?? `Error: Request failed (${code})`);
}

export const peersCommand = defineCommand({
  meta: { name: "peers", description: "List connected peers" },
  args: {
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

      const res = await fetch(`${profile.gatewayUrl}/api/sync/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        throw Object.assign(new Error("peers_request_failed"), { code: "peers_request_failed" });
      }

      const data = (await res.json()) as PeerStatus;
      const peers = data.peers ?? [];

      if (json) {
        console.log(formatCliSuccess({
          profile: profile.name,
          gatewayUrl: profile.gatewayUrl,
          peers,
        }));
        return;
      }

      if (peers.length === 0) {
        console.log("No peers connected.");
        return;
      }

      console.log("Connected peers:");
      for (const peer of peers) {
        const since = new Date(peer.connectedAt).toISOString();
        console.log(`  ${peer.peerId} (${peer.hostname}) — since ${since}`);
      }
    } catch (err: unknown) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
