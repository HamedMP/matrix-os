import type { CSSProperties } from "react";
import type { BadgeVariant } from "../Badge.js";
import type { PrivateNetworkState, PrivateNetworkStatus } from "./client.js";

export const mutedText: CSSProperties = { color: "var(--matrix-muted-fg)", fontSize: "0.8125rem", margin: 0, lineHeight: 1.5 };
export const linkStyle: CSSProperties = { color: "var(--matrix-primary)", textDecoration: "underline", wordBreak: "break-all" };

export const STATUS_POLL_MS = 3_000;
/** Once settled (connected, stopped, ...): slow, but a change made elsewhere still shows. */
export const STATUS_IDLE_POLL_MS = 30_000;
export const LOGIN_POLL_LIMIT_MS = 10 * 60_000;
export const MACHINES_POLL_MS = 5_000;
/** While Machines is open without a join code: slow, but a machine going offline still shows. */
export const MACHINES_IDLE_POLL_MS = 30_000;

/** Fixed client copy. Server error strings are never shown. */
export const PRIVATE_NETWORK_ERRORS = {
  load: "Could not load the private network status. Try again.",
  connect: "Could not start the connection. Try again.",
  disconnect: "Could not disconnect. Try again.",
  machines: "Could not load your machines. Try again.",
  joinCode: "Could not create a join code. Try again.",
  remove: "Could not remove the machine. Try again.",
  removeConflict: "The machine list changed. Check it and try again.",
  copy: "Could not copy. Select the text and copy it manually.",
  loginTimedOut: "Sign-in took too long. Connect again to get a new login link.",
} as const;

export interface StateCopy {
  badge: string;
  variant: BadgeVariant;
  description: string;
}

const STATE_COPY: Record<Exclude<PrivateNetworkState, "unsupported">, StateCopy> = {
  "not-installed": {
    badge: "Not installed",
    variant: "default",
    description:
      "Tailscale is not installed on this computer. Re-run the Matrix installer with --access tailscale to install it.",
  },
  "logged-out": {
    badge: "Not connected",
    variant: "default",
    description: "Connect this computer to your Tailscale network to reach Matrix privately from your other devices.",
  },
  "needs-login": {
    badge: "Sign-in needed",
    variant: "warning",
    description: "Open the login page and sign in with your Tailscale account to finish connecting.",
  },
  stopped: {
    badge: "Disconnected",
    variant: "default",
    description: "This computer is signed in but not connected to your private network.",
  },
  connected: {
    badge: "Connected",
    variant: "success",
    description: "This computer is reachable from devices on your private network.",
  },
  unavailable: {
    badge: "Unavailable",
    variant: "error",
    description: "The private network service did not respond. Retry in a moment.",
  },
};

export function stateCopy(state: Exclude<PrivateNetworkState, "unsupported">): StateCopy {
  return STATE_COPY[state];
}

export function shouldHidePanel(status: PrivateNetworkStatus): boolean {
  return !status.supported || status.state === "unsupported";
}

/** HTTP status from shell (`status`) or Electron Desktop (`httpStatus`) request errors. */
export function requestErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { status?: unknown; httpStatus?: unknown };
  if (typeof record.status === "number") return record.status;
  if (typeof record.httpStatus === "number") return record.httpStatus;
  return undefined;
}

export function minutesLeft(expiresAt: string, nowMs: number): number {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, Math.ceil((expires - nowMs) / 60_000));
}

export function expiryLabel(expiresAt: string, nowMs: number): string {
  const minutes = minutesLeft(expiresAt, nowMs);
  return minutes > 0 ? `Expires in ${minutes} min` : "Expired";
}

export function isSafeLinkUrl(value: string | null | undefined): value is string {
  if (!value || !URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "https:" || protocol === "http:";
}

export function onlineLabel(online: boolean | null): string {
  if (online === true) return "Online";
  if (online === false) return "Offline";
  return "Status unknown";
}

const pairedDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function formatPairedDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? pairedDate.format(time) : "Unknown date";
}

/** Logs a request failure without echoing provider or path details. */
export function logRequestFailure(scope: string, error: unknown): void {
  console.warn(`[private-network] ${scope} failed`, error instanceof Error ? error.name : typeof error);
}
