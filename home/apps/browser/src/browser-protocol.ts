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

const SAFE_BROWSER_MESSAGES: Record<string, string> = {
  browser_unavailable: "Browser is unavailable right now.",
  unauthorized: "Browser request is invalid.",
  invalid_request: "Browser request is invalid.",
  validation_error: "Browser request is invalid.",
  unsafe_url: "This destination is blocked.",
  blocked_redirect: "This destination is blocked.",
  limit_reached: "Browser limit reached.",
  profile_locked: "This profile is already open on another device.",
  takeover_required: "This profile is already open on another device.",
  session_not_found: "Browser session was not found.",
  download_not_found: "Download was not found.",
  deferred_feature: "This site feature is unavailable in Matrix Browser v1.",
  conflict: "Browser request conflicted with a newer change.",
  upgrade_required: "Browser needs to be refreshed.",
  stale_focus: "Browser input came from a background surface.",
  media_policy: "Browser media relay is unavailable.",
  internal_error: "Browser is unavailable right now.",
};

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
    headers: {
      "content-type": "application/json",
      ...(opts.handoffToken ? { "x-browser-handoff": "1" } : {}),
    },
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
    const code = typeof body?.error?.code === "string" ? body.error.code : "";
    throw new BrowserProtocolError(SAFE_BROWSER_MESSAGES[code] ?? "Browser is unavailable right now.");
  }
  return body as BrowserSessionResponse;
}
