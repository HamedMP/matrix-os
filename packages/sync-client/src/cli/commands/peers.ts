import { defineCommand } from "citty";
import { loadAuth } from "../../auth/token-store.js";
import { loadConfig } from "../../lib/config.js";

export const peersCommand = defineCommand({
  meta: { name: "peers", description: "List connected peers" },
  run: async () => {
    const config = await loadConfig();
    const auth = await loadAuth();

    if (!config || !auth) {
      console.error("Not configured. Run 'matrixos login' and 'matrixos sync' first.");
      process.exit(1);
    }

    const res = await fetch(`${config.gatewayUrl}/api/sync/status`, {
      headers: { authorization: `Bearer ${auth.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`Failed to fetch peer status: ${res.status}`);
      process.exit(1);
    }

    const data = (await res.json()) as {
      peers?: { peerId: string; hostname: string; connectedAt: number }[];
    };

    if (!data.peers || data.peers.length === 0) {
      console.log("No peers connected.");
      return;
    }

    console.log("Connected peers:");
    for (const peer of data.peers) {
      const since = new Date(peer.connectedAt).toISOString();
      console.log(`  ${peer.peerId} (${peer.hostname}) — since ${since}`);
    }
  },
});
