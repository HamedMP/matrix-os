/**
 * Private network (Tailscale / Headscale) and machine pairing client contract
 * for spec 2701. The gateway routes live in
 * `packages/gateway/src/private-network/routes.ts`; both sides must agree on
 * these shapes. Surfaces inject a transport bound to their gateway client.
 */

export const PRIVATE_NETWORK_BASE_PATH = "/api/system/private-network";

export type PrivateNetworkAccessMode = "tailscale" | "headscale" | "public";

export type PrivateNetworkState =
  /** This computer is not a self-hosted Matrix install. Hide the panel. */
  | "unsupported"
  /** Tailscale is not installed on the machine. */
  | "not-installed"
  /** Installed, never logged in or logged out. */
  | "logged-out"
  /** A login was started; open `loginUrl` to finish it. */
  | "needs-login"
  /** Logged in but disconnected (`tailscale down`). */
  | "stopped"
  | "connected"
  /** tailscaled did not answer. */
  | "unavailable";

export interface PrivateNetworkMachine {
  /** Short machine name in the tailnet. */
  name: string;
  /** MagicDNS name without the trailing dot, e.g. `box.tail1234.ts.net`. */
  dnsName: string;
  /** URL that opens Matrix on this machine over the tailnet. */
  url: string;
}

export interface PrivateNetworkStatus {
  supported: boolean;
  accessMode: PrivateNetworkAccessMode | null;
  state: PrivateNetworkState;
  /** Only for `needs-login`: the Tailscale/Headscale login page. */
  loginUrl: string | null;
  tailnet: string | null;
  machine: PrivateNetworkMachine | null;
  /** True when the current request reached Matrix through the private network. */
  viaPrivateNetwork: boolean;
}

export interface PairedMachine {
  /** Stable id derived from the machine's Ed25519 public key. */
  id: string;
  name: string;
  dnsName: string;
  url: string;
  pairedAt: string;
  /** From `tailscale status`; null when the network state is unknown. */
  online: boolean | null;
}

export interface PairedMachinesResponse {
  machines: PairedMachine[];
  /** Pairing revision; send it back when removing a machine. */
  revision: number;
}

export interface JoinCodeResponse {
  /** Single-use join code, shown once. */
  code: string;
  expiresAt: string;
  /** One-line install command to run on the second server. */
  command: string;
}

export interface PrivateNetworkTransport {
  get<T>(path: string, signal: AbortSignal): Promise<T>;
  post<T>(path: string, body: unknown, signal: AbortSignal): Promise<T>;
  delete<T>(path: string, body: unknown, signal: AbortSignal): Promise<T>;
}

export interface PrivateNetworkClient {
  status(signal: AbortSignal): Promise<PrivateNetworkStatus>;
  connect(signal: AbortSignal): Promise<PrivateNetworkStatus>;
  disconnect(signal: AbortSignal): Promise<PrivateNetworkStatus>;
  machines(signal: AbortSignal): Promise<PairedMachinesResponse>;
  createJoinCode(signal: AbortSignal): Promise<JoinCodeResponse>;
  removeMachine(id: string, revision: number, signal: AbortSignal): Promise<PairedMachinesResponse>;
}

const MACHINE_ID = /^[a-f0-9]{32}$/;

export function createPrivateNetworkClient(transport: PrivateNetworkTransport): PrivateNetworkClient {
  const base = PRIVATE_NETWORK_BASE_PATH;
  return {
    status: (signal) => transport.get(base, signal),
    connect: (signal) => transport.post(`${base}/connect`, {}, signal),
    disconnect: (signal) => transport.post(`${base}/disconnect`, { confirm: true }, signal),
    machines: (signal) => transport.get(`${base}/machines`, signal),
    createJoinCode: (signal) => transport.post(`${base}/join-codes`, {}, signal),
    removeMachine: (id, revision, signal) => {
      if (!MACHINE_ID.test(id)) return Promise.reject(new Error("Invalid machine"));
      return transport.delete(`${base}/machines/${id}`, { revision }, signal);
    },
  };
}
