import { randomUUID } from "node:crypto";
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
  return {
    urls: opts.urls,
    username: `${opts.ownerId}:${opts.sessionId}:${randomUUID()}`,
    credential: opts.secret,
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
  const addresses = candidate.match(/(?:^| )(?:\d{1,3}\.){3}\d{1,3}(?= |$)/g) ?? [];
  for (const raw of addresses) {
    const address = raw.trim();
    if (isIP(address) === 4 && PRIVATE_IPV4.some((pattern) => pattern.test(address))) {
      throw new Error("media_policy");
    }
  }
  if (/\b(?:localhost|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i.test(candidate)) {
    throw new Error("media_policy");
  }
}

export function chromiumBrowserLaunchArgs(): string[] {
  return [
    "--password-store=basic",
    "--disable-features=Translate",
    "--autoplay-policy=no-user-gesture-required",
  ];
}
