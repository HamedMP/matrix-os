import type { PlatformApp } from "./platform-app-types.js";
/** Drain owned request authority before its shared infrastructure is destroyed. */
export async function shutdownPlatformApp(app: Pick<PlatformApp, "shutdownPostHog" | "shutdownBrowserApprovals">) {
  try { await app.shutdownBrowserApprovals?.(); } finally { await app.shutdownPostHog(); }
}
