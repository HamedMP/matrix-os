/** Self-host private network settings, written to host.env by install-server.sh (spec 2701). */
export type PrivateNetworkAccessMode = "tailscale" | "headscale" | "public";

export interface PrivateNetworkConfig {
  selfHosted: boolean;
  accessMode: PrivateNetworkAccessMode | null;
  /** Headscale server origin, e.g. `https://hs.example.com`. */
  loginServer: string | null;
  installOwnerLogin: string | null;
  runUser: string | null;
  updateChannel: string | null;
  ownerId: string | null;
  machineId: string | null;
  tailscaleBin: string;
}

const ACCESS_MODES = new Set<PrivateNetworkAccessMode>(["tailscale", "headscale", "public"]);

function httpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function readPrivateNetworkConfig(env: NodeJS.ProcessEnv = process.env): PrivateNetworkConfig {
  const mode = env.MATRIX_ACCESS_MODE as PrivateNetworkAccessMode | undefined;
  const runUser = env.MATRIX_RUNTIME_USER;
  const channel = env.MATRIX_UPDATE_CHANNEL;
  const selfHosted = env.MATRIX_SELF_HOSTED === "1";
  return {
    selfHosted,
    // Installs from before spec 2701 have no access mode and kept nginx Basic Auth.
    accessMode: selfHosted ? (mode && ACCESS_MODES.has(mode) ? mode : "public") : null,
    loginServer: httpsOrigin(env.MATRIX_TAILSCALE_LOGIN_SERVER),
    installOwnerLogin: env.MATRIX_TAILSCALE_OWNER_LOGIN?.trim() || null,
    runUser: runUser && /^[a-z_][a-z0-9_-]{0,31}$/.test(runUser) ? runUser : null,
    updateChannel: channel && /^[A-Za-z0-9._-]{1,32}$/.test(channel) ? channel : null,
    ownerId: env.MATRIX_USER_ID?.trim() || null,
    machineId: env.MATRIX_MACHINE_ID?.trim() || null,
    tailscaleBin: env.MATRIX_TAILSCALE_BIN && env.MATRIX_TAILSCALE_BIN.startsWith("/") ? env.MATRIX_TAILSCALE_BIN : "/usr/bin/tailscale",
  };
}
