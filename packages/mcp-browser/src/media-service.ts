import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";

const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

export interface BrowserMediaBudget {
  maxWidth: number;
  maxHeight: number;
  maxFrameRate: number;
  maxBitrateKbps: number;
  audio: boolean;
  muted: boolean;
}

export interface TurnCredential {
  urls: string[];
  username: string;
  credential: string;
  expiresAt: string;
}

export interface BrowserMediaOffer {
  type: "media.offer";
  payload: {
    sdp: string;
    iceServers: Array<Pick<TurnCredential, "urls" | "username" | "credential">>;
    iceTransportPolicy: "relay";
  };
}

export const DEFAULT_BROWSER_MEDIA_BUDGET: BrowserMediaBudget = {
  maxWidth: 1280,
  maxHeight: 720,
  maxFrameRate: 30,
  maxBitrateKbps: 2500,
  audio: true,
  muted: true,
};

export function createBrowserMediaOffer(opts: {
  sdp: string;
  turn: TurnCredential;
}): BrowserMediaOffer {
  return {
    type: "media.offer",
    payload: {
      sdp: opts.sdp,
      iceServers: [
        {
          urls: opts.turn.urls,
          username: opts.turn.username,
          credential: opts.turn.credential,
        },
      ],
      iceTransportPolicy: "relay",
    },
  };
}

export function createFallbackFrameQueue<T>(maxFrames = 3): {
  push(frame: T): void;
  values(): T[];
} {
  const frames: T[] = [];
  return {
    push(frame) {
      frames.push(frame);
      while (frames.length > maxFrames) frames.shift();
    },
    values() {
      return [...frames];
    },
  };
}

export function createEphemeralTurnCredential(opts: {
  ownerId: string;
  sessionId: string;
  urls: string[];
  secret: string;
  now?: number;
  ttlMs?: number;
}): TurnCredential {
  if (opts.secret.length === 0) {
    throw new Error("turn_secret_required");
  }
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  const expiresSeconds = Math.floor((now + ttlMs) / 1000);
  const username = `${expiresSeconds}:${opts.ownerId}:${opts.sessionId}:${randomUUID()}`;
  return {
    urls: opts.urls,
    username,
    credential: createHmac("sha1", opts.secret).update(username).digest("base64"),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

export function isRelayIceCandidate(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  return lower.includes(" typ relay ") || lower.endsWith(" typ relay");
}

export function assertRelayIceCandidate(candidate: string): void {
  if (!isRelayIceCandidate(candidate)) {
    throw new Error("media_policy");
  }
  const parts = candidate.trim().split(/\s+/);
  const address = parts[4];
  if (!address || !isPublicIceAddress(address) || /\blocalhost\b/i.test(candidate)) {
    throw new Error("media_policy");
  }
}

function isPublicIceAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPublicIpv4(mapped[1] ?? "");
  const ipVersion = isIP(address);
  if (ipVersion === 4) return isPublicIpv4(address);
  if (ipVersion === 6) {
    const lower = address.toLowerCase();
    const firstHextet = firstIpv6Hextet(lower);
    return !(
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      (firstHextet !== null && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
      lower.startsWith("ff")
    );
  }
  return false;
}

function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a = -1, b = -1, c = -1] = address.split(".").map((part) => Number.parseInt(part, 10));
  return !(
    PRIVATE_IPV4.some((pattern) => pattern.test(address)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function firstIpv6Hextet(address: string): number | null {
  const match = address.match(/^([0-9a-f]{1,4})(?=:|$)/);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 16);
}

export function chromiumBrowserLaunchArgs(): string[] {
  return [
    "--password-store=basic",
    "--disable-features=Translate",
    "--autoplay-policy=no-user-gesture-required",
  ];
}
