import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";

export interface BrowserTurnCredential {
  urls: string[];
  username: string;
  credential: string;
  expiresAt: string;
  iceTransportPolicy: "relay";
}

export function mintBrowserTurnCredential(opts: {
  ownerId: string;
  sessionId: string;
  urls: string[];
  secret: string;
  now?: number;
  ttlSeconds?: number;
}): BrowserTurnCredential {
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const expires = nowSeconds + (opts.ttlSeconds ?? 300);
  const username = `${expires}:${opts.ownerId}:${opts.sessionId}:${randomUUID()}`;
  const credential = createHmac("sha1", opts.secret).update(username).digest("base64");
  return {
    urls: opts.urls,
    username,
    credential,
    expiresAt: new Date(expires * 1000).toISOString(),
    iceTransportPolicy: "relay",
  };
}

export function isBrowserRelayCandidate(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  if (!(lower.includes(" typ relay ") || lower.endsWith(" typ relay"))) {
    return false;
  }
  if (/\b(?:localhost|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i.test(candidate)) {
    return false;
  }
  const addresses = candidate.match(/(?:^| )(?:\d{1,3}\.){3}\d{1,3}(?= |$)/g) ?? [];
  for (const rawAddress of addresses) {
    const address = rawAddress.trim();
    if (isIP(address) !== 4) return false;
    const [a, b] = address.split(".").map((part) => Number.parseInt(part, 10));
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return false;
    }
  }
  return true;
}

export function assertBrowserRelayCandidate(candidate: string): void {
  if (!isBrowserRelayCandidate(candidate)) {
    throw new Error("media_policy");
  }
}
