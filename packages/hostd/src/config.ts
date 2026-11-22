import { isAbsolute } from "node:path";
import { z } from "zod/v4";

// hostd configuration from the environment. Fails closed: missing or short
// tokens and missing TLS material stop startup. Errors name the offending
// variables only, never their values.

export interface HostdConfig {
  apiToken: string;
  ingressToken: string;
  tlsCertPath: string;
  tlsKeyPath: string;
  apiHost: string;
  apiPort: number;
  ingressHost: string;
  ingressPort: number;
  // Holds vms/ (records, seeds, unit env) and snapshots/ (the data pool).
  stateDir: string;
  // Holds <id>/ch.sock and <id>/vsock.sock for each VM.
  runDir: string;
  // Thin pool admission thresholds (percent) for new VMs.
  poolMaxDataPercent: number;
  poolMaxMetadataPercent: number;
}

export class ConfigError extends Error {
  constructor(readonly keys: string[]) {
    super(`invalid hostd configuration: ${keys.join(", ")}`);
    this.name = "ConfigError";
  }
}

const token = z.string().min(32).max(512);
const absolutePath = z.string().min(1).max(4096).refine(isAbsolute);
const port = z.coerce.number().int().min(1).max(65_535);
const host = z.string().min(1).max(255);
const percent = z.coerce.number().min(1).max(100);

const Env = z.object({
  HOSTD_API_TOKEN: token,
  HOSTD_INGRESS_TOKEN: token,
  HOSTD_TLS_CERT_PATH: absolutePath,
  HOSTD_TLS_KEY_PATH: absolutePath,
  HOSTD_API_HOST: host.default("0.0.0.0"),
  HOSTD_API_PORT: port.default(8443),
  HOSTD_INGRESS_HOST: host.default("0.0.0.0"),
  HOSTD_INGRESS_PORT: port.default(443),
  HOSTD_STATE_DIR: absolutePath.default("/var/lib/matrix-hostd"),
  HOSTD_RUN_DIR: absolutePath.default("/run/matrix-vm"),
  HOSTD_POOL_MAX_DATA_PERCENT: percent.default(85),
  HOSTD_POOL_MAX_METADATA_PERCENT: percent.default(80),
});

export function loadConfig(env: Record<string, string | undefined>): HostdConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort();
    throw new ConfigError(keys);
  }
  const e = parsed.data;
  if (e.HOSTD_API_TOKEN === e.HOSTD_INGRESS_TOKEN) throw new ConfigError(["HOSTD_INGRESS_TOKEN"]);
  return {
    apiToken: e.HOSTD_API_TOKEN,
    ingressToken: e.HOSTD_INGRESS_TOKEN,
    tlsCertPath: e.HOSTD_TLS_CERT_PATH,
    tlsKeyPath: e.HOSTD_TLS_KEY_PATH,
    apiHost: e.HOSTD_API_HOST,
    apiPort: e.HOSTD_API_PORT,
    ingressHost: e.HOSTD_INGRESS_HOST,
    ingressPort: e.HOSTD_INGRESS_PORT,
    stateDir: e.HOSTD_STATE_DIR,
    runDir: e.HOSTD_RUN_DIR,
    poolMaxDataPercent: e.HOSTD_POOL_MAX_DATA_PERCENT,
    poolMaxMetadataPercent: e.HOSTD_POOL_MAX_METADATA_PERCENT,
  };
}
