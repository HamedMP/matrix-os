import { PeerInfoSchema } from "./types.js";

const MAX_PEER_ID_LENGTH = 128;

export function sanitizePeerId(raw: string | undefined): string {
  const candidate = raw ?? "unknown";
  const parsed = PeerInfoSchema.shape.peerId.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }

  if (typeof raw === "string" && raw.length > MAX_PEER_ID_LENGTH) {
    const truncated = raw.slice(0, MAX_PEER_ID_LENGTH);
    const truncatedParsed = PeerInfoSchema.shape.peerId.safeParse(truncated);
    if (truncatedParsed.success) {
      return truncatedParsed.data;
    }
  }

  return "unknown";
}
