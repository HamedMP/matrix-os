import { MESSAGING_BRIDGE_NETWORKS, type MessagingBridgeNetwork } from "@matrix-os/contracts/messaging-bridge";
import { HANDLE_PATTERN } from "../platform-route-utils.js";

/**
 * Bridge-host configuration (spec 2701). The platform is the only holder of
 * these secrets. A missing host URL, admin token, appservice token, gate secret,
 * server name or identity key leaves the routes mounted but answering `503 misconfigured`.
 *
 * Sources: the bridge host's `platform.env` (written by
 * `distro/messaging-bridge-host/bootstrap.sh`) carries
 * `MESSAGING_BRIDGE_HOST_URL`, `_SERVER_NAME`, `_ADMIN_TOKEN`,
 * `_DOUBLEPUPPET_AS_TOKEN`, `_GATE_SECRET`, `_USER_ID_KEY` and
 * `_PROVISIONING_SECRET_<NETWORK>`. The identity key is generated there so it
 * is backed up with the host; never rotate it (stored identities survive, new
 * owners would derive from the new key). Only `MESSAGING_BRIDGE_ALLOWED_HANDLES`
 * (comma-separated handles) is managed on the platform side.
 */
export interface MessagingBridgeHostConfig {
  hostUrl: string;
  serverName: string;
  adminToken: string;
  /** as_token of the owner-scoped double-puppet appservice; mints device-bound owner tokens. */
  appserviceToken: string;
  gateSecret: string;
  userIdKey: string;
  /** Networks absent here are omitted from sessions and answer `503 misconfigured`. */
  provisioningSecrets: Partial<Record<MessagingBridgeNetwork, string>>;
}

export interface MessagingBridgeConfig {
  allowedHandles: ReadonlySet<string>;
  host: MessagingBridgeHostConfig | null;
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9.-]{1,200}(:[0-9]{1,5})?$/;
const MIN_SECRET_LENGTH = 16;
const MAX_ALLOWED_HANDLES = 1_000;

function secret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length >= MIN_SECRET_LENGTH && trimmed.length <= 4_096 ? trimmed : undefined;
}

function parseHostUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (error: unknown) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
  const normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return normalized.length <= 200 ? normalized : undefined;
}

export function parseAllowedHandles(value: string | undefined): ReadonlySet<string> {
  const handles = new Set<string>();
  for (const entry of (value ?? "").split(",")) {
    const handle = entry.trim().toLowerCase();
    if (handle && HANDLE_PATTERN.test(handle) && handles.size < MAX_ALLOWED_HANDLES) handles.add(handle);
  }
  return handles;
}

export function parseMessagingBridgeConfig(env: NodeJS.ProcessEnv): MessagingBridgeConfig {
  const allowedHandles = parseAllowedHandles(env.MESSAGING_BRIDGE_ALLOWED_HANDLES);
  const hostUrl = parseHostUrl(env.MESSAGING_BRIDGE_HOST_URL);
  const serverName = env.MESSAGING_BRIDGE_SERVER_NAME?.trim();
  const adminToken = secret(env.MESSAGING_BRIDGE_ADMIN_TOKEN);
  const appserviceToken = secret(env.MESSAGING_BRIDGE_DOUBLEPUPPET_AS_TOKEN);
  const gateSecret = secret(env.MESSAGING_BRIDGE_GATE_SECRET);
  const userIdKey = secret(env.MESSAGING_BRIDGE_USER_ID_KEY);
  if (!hostUrl || !serverName || !SERVER_NAME_PATTERN.test(serverName) || !adminToken || !appserviceToken || !gateSecret || !userIdKey) {
    return { allowedHandles, host: null };
  }
  const provisioningSecrets: Partial<Record<MessagingBridgeNetwork, string>> = {};
  for (const network of MESSAGING_BRIDGE_NETWORKS) {
    const value = secret(env[`MESSAGING_BRIDGE_PROVISIONING_SECRET_${network.toUpperCase()}`]);
    if (value) provisioningSecrets[network] = value;
  }
  return { allowedHandles, host: { hostUrl, serverName, adminToken, appserviceToken, gateSecret, userIdKey, provisioningSecrets } };
}

/** Networks with a provisioning secret, in contract order. */
export function configuredNetworks(host: MessagingBridgeHostConfig): MessagingBridgeNetwork[] {
  return MESSAGING_BRIDGE_NETWORKS.filter(network => host.provisioningSecrets[network] !== undefined);
}
