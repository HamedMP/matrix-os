export interface BrowserSessionResponse {
  session: {
    id: string;
    ownerId?: string;
    profileId: string;
    state: "active" | "starting" | "hibernated" | "recoverable" | "locked";
    currentTabId: string | null;
    takeoverRequired: boolean;
    mediaMode: "webrtc" | "fallback_frame";
    protocolVersion: number;
  };
  streamToken: string | null;
  wsUrl: string | null;
}

export const BROWSER_API_TIMEOUT_MS = 10_000;

export function browserApiSignal(): AbortSignal {
  return AbortSignal.timeout(BROWSER_API_TIMEOUT_MS);
}

export class BrowserProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserProtocolError";
  }
}

export function normalizeBrowserTarget(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "about:blank";
  if (trimmed === "about:blank") return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    return new URL(trimmed).toString();
  }
  return new URL(`https://${trimmed}`).toString();
}

export async function createBrowserSession(opts: {
  targetUrl: string;
  profileName?: string;
  surface: "canvas" | "standalone";
  deviceId: string;
  handoffToken?: string;
}): Promise<BrowserSessionResponse> {
  const res = await fetch("/api/browser/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: browserApiSignal(),
    body: JSON.stringify({
      profileName: opts.profileName ?? "default",
      targetUrl: normalizeBrowserTarget(opts.targetUrl),
      handoffToken: opts.handoffToken,
      surface: opts.surface,
      deviceId: opts.deviceId,
    }),
  });
  const body = await res.json().catch((error: unknown) => {
    console.warn("[browser-app] Invalid Browser response:", error instanceof Error ? error.message : String(error));
    throw new BrowserProtocolError("Browser is unavailable right now.");
  });
  if (!res.ok) {
    const safeMessage = typeof body?.error?.message === "string" && body.error.message.length < 160
      ? body.error.message
      : "Browser is unavailable right now.";
    throw new BrowserProtocolError(safeMessage);
  }
  return body as BrowserSessionResponse;
}
