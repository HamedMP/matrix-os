/** Self-host private network settings, written to host.env by install-server.sh (spec 2701). */
export type PrivateNetworkAccessMode = "tailscale" | "headscale" | "public";

export interface PrivateNetworkConfig {
  selfHosted: boolean;
  accessMode: PrivateNetworkAccessMode | null;
  /** Headscale server URL, path included, e.g. `https://hs.example.com/headscale`. */
  loginServer: string | null;
  installOwnerLogin: string | null;
  runUser: string | null;
  updateChannel: string | null;
  ownerId: string | null;
  machineId: string | null;
  tailscaleBin: string;
  /** How install-server.sh served Matrix on the tailnet (HTTP when the tailnet has no certificates). */
  tailnetScheme: "http" | "https" | null;
}

const ACCESS_MODES = new Set<PrivateNetworkAccessMode>(["tailscale", "headscale", "public"]);

// Same path characters the installer accepts for --login-server; the value is
// also printed into the join command, so nothing shell-sensitive gets through.
const LOGIN_SERVER_PATH = /^(?:\/[A-Za-z0-9._~-]*)*$/;

/**
 * Headscale control-server URL as configured (https, host, port and path),
 * without a trailing slash. Credentials, a query or a fragment reject it.
 */
function headscaleLoginServer(value: string | undefined): string | null {
  if (!value || value.length > 2048 || /[?#]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (!LOGIN_SERVER_PATH.test(url.pathname)) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function urlScheme(value: string | undefined): "http" | "https" | null {
  if (!value) return null;
  if (value.startsWith("https://")) return "https";
  if (value.startsWith("http://")) return "http";
  return null;
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
    loginServer: headscaleLoginServer(env.MATRIX_TAILSCALE_LOGIN_SERVER),
    installOwnerLogin: env.MATRIX_TAILSCALE_OWNER_LOGIN?.trim() || null,
    runUser: runUser && /^[a-z_][a-z0-9_-]{0,31}$/.test(runUser) ? runUser : null,
    updateChannel: channel && /^[A-Za-z0-9._-]{1,32}$/.test(channel) ? channel : null,
    ownerId: env.MATRIX_USER_ID?.trim() || null,
    machineId: env.MATRIX_MACHINE_ID?.trim() || null,
    tailnetScheme: urlScheme(env.MATRIX_TAILNET_URL),
    tailscaleBin: env.MATRIX_TAILSCALE_BIN && env.MATRIX_TAILSCALE_BIN.startsWith("/") ? env.MATRIX_TAILSCALE_BIN : "/usr/bin/tailscale",
  };
}
