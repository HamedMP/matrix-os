import type { evaluateDesktopReleaseState } from "@matrix-os/contracts";

export type DesktopReleaseChannel ="stable" | "beta" | "canary" | "dev";

export interface DesktopChannelIdentity {
  readonly channel: DesktopReleaseChannel;
  /** Electron app name: drives the user data directory and Safe Storage service. */
  readonly appName: string;
  /** Packaged bundle identifier; desktop/electron-builder*.yml must match. */
  readonly appId: string;
  readonly deepLinkSchemes: readonly string[];
  readonly authRedirectUri: string;
}

const STABLE_IDENTITY = {
  appName: "Matrix OS",
  appId: "com.matrix-os.operator",
  deepLinkSchemes: ["matrixos", "matrix-os"],
  authRedirectUri: "matrixos://auth?status=approved",
} as const;

// Canary installs beside stable, so it owns a separate bundle id, profile,
// keychain service and URL scheme. Beta and dev stay on the stable identity.
const CANARY_IDENTITY = {
  appName: "Matrix OS Canary",
  appId: "com.matrix-os.operator.canary",
  deepLinkSchemes: ["matrixos-canary"],
  authRedirectUri: "matrixos-canary://auth?status=approved",
} as const;

/** Every packaged profile directory name, for QA-isolation overlap checks. */
export const DESKTOP_PRODUCTION_APP_NAMES = [STABLE_IDENTITY.appName, CANARY_IDENTITY.appName] as const;

export function normalizeDesktopChannel(value: string | undefined): DesktopReleaseChannel {
  if (value === "beta" || value === "canary" || value === "dev") return value;
  return "stable";
}

export function resolveDesktopChannelIdentity(value: string | undefined): DesktopChannelIdentity {
  const channel = normalizeDesktopChannel(value);
  return { channel, ...(channel === "canary" ? CANARY_IDENTITY : STABLE_IDENTITY) };
}

export function isDesktopDeepLink(value: string, identity: DesktopChannelIdentity): boolean {
  try {
    const url = new URL(value);
    return identity.deepLinkSchemes.some((scheme) => url.protocol === `${scheme}:`);
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/**
 * Prerelease builds come from main HEAD and rarely match the computer's host
 * bundle, so only protocol incompatibility opens the update dialog there.
 */
export function showsReleaseAlignmentNotice(
  state: Pick<ReturnType<typeof evaluateDesktopReleaseState>, "status" | "protocol">,
  channel: DesktopReleaseChannel,
): boolean {
  if (state.status === "aligned" || state.status === "unavailable") return false;
  if (state.protocol === "desktop-update-required" || state.protocol === "runtime-update-required") return true;
  return channel === "stable";
}
