import { z } from "zod/v4";

const Peer = z.object({
  peerId: z.string().max(128), hostname: z.string().max(256),
  platform: z.string().max(32), connectedAt: z.number().finite(),
});
const Snapshot = z.object({ connectedPeers: z.array(Peer).max(1000) });

/** Short-lived, bounded peer snapshot. Null means unavailable, not no peers. */
export function createLiveStatus(
  config: { gatewayUrl: string; token: string },
  warn: (error: unknown) => void,
) {
  let cached: z.infer<typeof Peer>[] | null = null;
  let expiresAt = 0;
  let inFlight: Promise<z.infer<typeof Peer>[] | null> | undefined;
  async function refresh() {
    try {
      const response = await fetch(`${config.gatewayUrl.replace(/\/$/, "")}/api/sync/status`, {
        headers: { authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(2_000), redirect: "error",
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Peer status unavailable");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 256 * 1024) throw new Error("Peer status too large");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      cached = Snapshot.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).connectedPeers;
    } catch (error: unknown) {
      warn(error);
      cached = null;
    } finally { expiresAt = Date.now() + 10_000; }
    return cached;
  }
  return {
    peers() {
      if (Date.now() < expiresAt) return Promise.resolve(cached);
      inFlight ??= refresh().finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
