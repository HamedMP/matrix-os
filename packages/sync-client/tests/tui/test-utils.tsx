import { renderToString } from "ink";
import type { ReactElement } from "react";
import type { TuiStatusSnapshot } from "../../src/cli/tui/status.js";

export const healthyTuiSnapshot: TuiStatusSnapshot = {
  overall: "healthy",
  profile: {
    name: "cloud",
    gatewayUrl: "https://app.matrix-os.com",
    platformUrl: "https://app.matrix-os.com",
    state: "healthy",
  },
  auth: { state: "authenticated", handle: "nim" },
  gateway: { state: "healthy", label: "ok" },
  daemon: { state: "healthy", label: "running" },
  sync: { state: "healthy", label: "sync ready" },
  sessions: { state: "healthy", count: 2 },
  blockingActions: [],
  refreshedAt: "2026-05-29T12:00:00.000Z",
};

export const loggedOutTuiSnapshot: TuiStatusSnapshot = {
  ...healthyTuiSnapshot,
  overall: "unauthenticated",
  auth: { state: "unauthenticated" },
  sessions: { state: "healthy", count: 0 },
  blockingActions: ["login"],
};

export const gatewayUnavailableTuiSnapshot: TuiStatusSnapshot = {
  ...healthyTuiSnapshot,
  overall: "degraded",
  gateway: { state: "degraded", label: "gateway degraded" },
  sessions: { state: "degraded", count: 0 },
};

export function renderTui(element: ReactElement): string {
  return renderToString(element);
}

export function visibleLines(output: string): string[] {
  return output.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}
